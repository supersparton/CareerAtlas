import { Processor, WorkerHost, InjectQueue } from '@nestjs/bullmq';
import { Queue, Job as BullJob } from 'bullmq';
import { Logger } from '@nestjs/common';
import { CamoufoxScraperService } from '../intelligence/camoufox-scraper.service';
import { PipelineCoordinatorService } from './pipeline-coordinator.service';
import { Job } from '../discovery/discovery.service';

interface ScrapingJobPayload {
  runId: string;
  discoveryPayload: {
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
  };
  job: Job;
}

@Processor('job-scraping', { concurrency: 2 }) // Low concurrency to prevent high CPU usage from headless browser instances
export class ScrapingWorker extends WorkerHost {
  private readonly logger = new Logger(ScrapingWorker.name);

  constructor(
    private readonly camoufoxScraperService: CamoufoxScraperService,
    private readonly coordinator: PipelineCoordinatorService,
    @InjectQueue('job-intelligence') private readonly intelligenceQueue: Queue,
  ) {
    super();
  }

  async process(bullJob: BullJob<ScrapingJobPayload>): Promise<any> {
    const { runId, discoveryPayload, job } = bullJob.data;

    try {
      this.coordinator.updateStep(runId, 'step-4', 'running');
      this.coordinator.addLog(runId, `Deep-scraping full details for "${job.title}" at "${job.company}" using anti-detect browser...`);

      if (job.applyUrl) {
        const fullDesc = await this.camoufoxScraperService.scrapeUrl(job.applyUrl);
        if (fullDesc && fullDesc.length > 200) {
          job.description = fullDesc;
          this.logger.log(`[SCRAPING-WORKER] Successfully enriched job description for "${job.title}"`);
          this.coordinator.addLog(runId, `Enriched job description for "${job.title}" (${fullDesc.length} chars).`);
        } else {
          this.logger.warn(`[SCRAPING-WORKER] Could not get full description for "${job.title}". Using fallback snippet.`);
        }
      }

      // Forward to Job Intelligence Queue
      await this.intelligenceQueue.add('parse-job', {
        runId,
        discoveryPayload,
        job,
      });

      return { success: true };
    } catch (err) {
      this.logger.error(`[SCRAPING-WORKER] Error in scraping job: ${err.message}`);
      
      // Fallback: forward to Job Intelligence Queue anyway so pipeline doesn't break
      await this.intelligenceQueue.add('parse-job', {
        runId,
        discoveryPayload,
        job,
      });
      
      return { success: false, error: err.message };
    }
  }
}
