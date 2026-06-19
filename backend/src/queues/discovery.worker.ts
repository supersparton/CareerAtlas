import { Processor, WorkerHost, InjectQueue } from '@nestjs/bullmq';
import { Queue, Job as BullJob } from 'bullmq';
import { Logger } from '@nestjs/common';
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
    this.coordinator.updateStep(runId, 'step-2', 'running');
    this.coordinator.addLog(runId, `[Cycle ${currentCycle}] Crawling for term "${searchTerm}" (Page ${page})...`);

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
      this.coordinator.addLog(runId, `[Cycle ${currentCycle}] Scraped ${rawScrapedJobs.length} raw jobs.`);
      this.coordinator.updateStep(runId, 'step-2', 'success');

      if (rawScrapedJobs.length === 0) {
        this.logger.warn(`[DISCOVERY-WORKER] No raw jobs found in cycle ${currentCycle}. Triggering matching stage immediately.`);
        this.coordinator.addLog(runId, `[Cycle ${currentCycle}] Warning: No jobs found. Proceeding to matching evaluation.`);
        
        // Enqueue matching job immediately since there are no child jobs to process
        await this.matchingQueue.add('evaluate', job.data);
        return { count: 0 };
      }

      // Initialize counter in coordinator
      this.coordinator.setTotalJobs(runId, rawScrapedJobs.length);
      this.coordinator.updateStep(runId, 'step-3', 'running');
      this.coordinator.addLog(runId, `[Cycle ${currentCycle}] Validation starting for ${rawScrapedJobs.length} jobs...`);

      // Enqueue each job for validation
      for (const rawJob of rawScrapedJobs) {
        await this.validationQueue.add('validate-job', {
          runId,
          discoveryPayload: job.data,
          job: rawJob,
        });
      }

      return { count: rawScrapedJobs.length };
    } catch (err) {
      this.logger.error(`[DISCOVERY-WORKER] Failed to ingest jobs: ${err.message}`, err.stack);
      this.coordinator.failRun(runId, `Discovery stage failed: ${err.message}`);
      throw err;
    }
  }
}
