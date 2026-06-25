import { Processor, WorkerHost, InjectQueue } from '@nestjs/bullmq';
import { Queue, Job as BullJob } from 'bullmq';
import { Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { AtsPortalsAgent } from '../discovery/ats-portals.agent';
import { StartupBoardsAgent } from '../discovery/startup-boards.agent';
import { IndiaFocusedAgent } from '../discovery/india-focused.agent';
import { LinkedInAgent } from '../discovery/linkedin.agent';
import { PipelineCoordinatorService } from './pipeline-coordinator.service';

interface DiscoveryJobPayload {
  runId: string;
  userId: number;
  searchTerms: string[];
  activeTermIndex: number;
  locationSearch: string;
  limit: number;
  currentCycle: number;
  maxCycles: number;
  page: number;
  accumulatedMatches: any[];
}

@Processor('job-discovery', { concurrency: 2 }) // Concurrency = 2 to prevent rate bans on scrapers
export class DiscoveryWorker extends WorkerHost {
  private readonly logger = new Logger(DiscoveryWorker.name);

  constructor(
    private readonly atsPortalsAgent: AtsPortalsAgent,
    private readonly startupBoardsAgent: StartupBoardsAgent,
    private readonly indiaFocusedAgent: IndiaFocusedAgent,
    private readonly linkedinAgent: LinkedInAgent,
    private readonly coordinator: PipelineCoordinatorService,
    @InjectQueue('job-validation') private readonly validationQueue: Queue,
    @InjectQueue('job-matching') private readonly matchingQueue: Queue,
  ) {
    super();
  }

  async process(job: BullJob<DiscoveryJobPayload>): Promise<any> {
    const { runId, searchTerms, activeTermIndex, locationSearch, page, currentCycle } = job.data;
    const searchTerm = searchTerms[activeTermIndex] || '';
    
    this.logger.log(`[DISCOVERY-WORKER] Starting run ${runId} cycle ${currentCycle} for term "${searchTerm}"...`);
    await this.coordinator.updateStep(runId, 'step-2', 'running');
    await this.coordinator.addLog(runId, `[Cycle ${currentCycle}] Crawling for term "${searchTerm}" (Page ${page})...`);

    try {
      // Run discovery agents in parallel
      const [atsJobs, startupJobs, indiaJobs, linkedinJobs] = await Promise.all([
        this.atsPortalsAgent.findJobs(searchTerm, locationSearch, page),
        this.startupBoardsAgent.findJobs(searchTerm, locationSearch, page),
        this.indiaFocusedAgent.findJobs(searchTerm, locationSearch, page),
        this.linkedinAgent.findJobs(searchTerm, locationSearch, page),
      ]);

      const rawScrapedJobs = [...atsJobs, ...startupJobs, ...indiaJobs, ...linkedinJobs];
      this.logger.log(`[DISCOVERY-WORKER] Ingested ${rawScrapedJobs.length} raw jobs for run ${runId}`);
      
      // Log the list of fetched jobs to Nest Logger (which captures them to DiscoveryWorker.log if DEBUG is true)
      if (rawScrapedJobs.length > 0) {
        this.logger.log(
          `[DISCOVERY-WORKER] Jobs fetched for search title "${searchTerm}" (Count: ${rawScrapedJobs.length}):\n` +
          rawScrapedJobs.map((j, idx) => `  ${idx + 1}. [Source: ${j.source}] "${j.title}" at "${j.company}" (URL: ${j.applyUrl || 'No URL'})`).join('\n')
        );
      }

      // If DEBUG is enabled, write a detailed and formatted summary to output/scraped_jobs.log
      if (process.env.DEBUG === 'true') {
        try {
          const cwd = process.cwd();
          let workspaceRoot = cwd;
          if (fs.existsSync(path.join(cwd, 'backend'))) {
            workspaceRoot = cwd;
          } else {
            const parent = path.resolve(cwd, '..');
            if (fs.existsSync(path.join(parent, 'backend'))) {
              workspaceRoot = parent;
            }
          }
          const outputDir = path.join(workspaceRoot, 'output');
          if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
          }
          const scraperLogFile = path.join(outputDir, 'scraped_jobs.log');
          const timestamp = new Date().toLocaleString();
          
          let logContent = `=========================================\n`;
          logContent += `Timestamp: ${timestamp}\n`;
          logContent += `Run ID: ${runId}\n`;
          logContent += `Search Title/Term: "${searchTerm}"\n`;
          logContent += `Location: "${locationSearch}"\n`;
          logContent += `Page: ${page}\n`;
          logContent += `Total Jobs Fetched: ${rawScrapedJobs.length}\n`;
          logContent += `-----------------------------------------\n`;
          
          if (rawScrapedJobs.length === 0) {
            logContent += `No jobs fetched for this search title.\n`;
          } else {
            rawScrapedJobs.forEach((j, idx) => {
              logContent += `${idx + 1}. [Source: ${j.source}] "${j.title}" at "${j.company}"\n`;
              logContent += `   URL: ${j.applyUrl || 'No URL'}\n`;
              if (j.description) {
                const snippet = j.description.length > 150 ? j.description.substring(0, 150) + '...' : j.description;
                logContent += `   Snippet: ${snippet.replace(/\r?\n/g, ' ')}\n`;
              }
            });
          }
          logContent += `=========================================\n\n`;
          
          fs.appendFileSync(scraperLogFile, logContent, 'utf8');
        } catch (err) {
          this.logger.error(`Failed to write scraped jobs to log file: ${err.message}`);
        }
      }

      await this.coordinator.addLog(runId, `[Cycle ${currentCycle}] Scraped ${rawScrapedJobs.length} raw jobs.`);
      await this.coordinator.updateStep(runId, 'step-2', 'success');

      if (rawScrapedJobs.length === 0) {
        this.logger.warn(`[DISCOVERY-WORKER] No raw jobs found in cycle ${currentCycle}. Triggering matching stage immediately.`);
        await this.coordinator.addLog(runId, `[Cycle ${currentCycle}] Warning: No jobs found. Proceeding to matching evaluation.`);
        
        // Enqueue matching job immediately since there are no child jobs to process
        await this.matchingQueue.add('evaluate', job.data);
        return { count: 0 };
      }

      // Initialize counter in coordinator
      await this.coordinator.setTotalJobs(runId, rawScrapedJobs.length);
      await this.coordinator.updateStep(runId, 'step-3', 'running');
      await this.coordinator.addLog(runId, `[Cycle ${currentCycle}] Validation starting for ${rawScrapedJobs.length} jobs...`);

      // Enqueue each job for validation
      for (const rawJob of rawScrapedJobs) {
        await this.validationQueue.add('validate-job', {
          runId,
          discoveryPayload: job.data,
          job: rawJob,
        });
      }

      return { count: rawScrapedJobs.length };
    } catch (err: any) {
      this.logger.error(`[DISCOVERY-WORKER] Failed to ingest jobs: ${err.message}`, err.stack);
      await this.coordinator.failRun(runId, `Discovery stage failed: ${err.message}`);
      throw err;
    }
  }
}
