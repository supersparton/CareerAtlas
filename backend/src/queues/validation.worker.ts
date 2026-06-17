import { Processor, WorkerHost, InjectQueue } from '@nestjs/bullmq';
import { Queue, Job as BullJob } from 'bullmq';
import { Logger } from '@nestjs/common';
import { ValidationService } from '../validation/validation.service';
import { ProfileService } from '../profile/profile.service';
import { PipelineCoordinatorService } from './pipeline-coordinator.service';
import { Job } from '../discovery/discovery.service';

interface ValidationJobPayload {
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

@Processor('job-validation', { concurrency: 10 }) // High concurrency as URL/duplicate checking is fast
export class ValidationWorker extends WorkerHost {
  private readonly logger = new Logger(ValidationWorker.name);

  constructor(
    private readonly validationService: ValidationService,
    private readonly profileService: ProfileService,
    private readonly coordinator: PipelineCoordinatorService,
    @InjectQueue('job-scraping') private readonly scrapingQueue: Queue,
    @InjectQueue('job-matching') private readonly matchingQueue: Queue,
  ) {
    super();
  }

  async process(bullJob: BullJob<ValidationJobPayload>): Promise<any> {
    const { runId, discoveryPayload, job } = bullJob.data;

    try {
      // Fetch user profile for location/remote checks
      const profile = await this.profileService.getProfileById(discoveryPayload.userId);

      const activeTerm = discoveryPayload.searchTerms[discoveryPayload.activeTermIndex] || '';

      // Perform validation checks
      const validationResult = await this.validationService.validateSingleJob(
        job,
        activeTerm,
        profile,
        discoveryPayload.userId
      );

      if (!validationResult.valid) {
        this.logger.log(`[VALIDATION-WORKER] Job discarded: "${job.title}" at "${job.company}" (${validationResult.reason})`);
        
        // Decrement remaining jobs counter
        const isBatchComplete = this.coordinator.decrementRemainingJobs(runId);
        if (isBatchComplete) {
          this.logger.log(`[VALIDATION-WORKER] Batch complete after discard. Triggering matching...`);
          await this.matchingQueue.add('evaluate', discoveryPayload);
        }
        return { valid: false, reason: validationResult.reason };
      }

      // If bypassed (job already exists in Qdrant store), skip LLM and Embedding extraction completely
      if (validationResult.bypassed) {
        this.logger.log(`[VALIDATION-WORKER] Job "${job.title}" already exists in Qdrant (semantic store). Bypassing Intelligence & Embedding layers.`);
        this.coordinator.addLog(runId, `Bypassed Intelligence & Embedding for "${job.title}" at ${job.company} (already indexed).`);
        
        const isBatchComplete = this.coordinator.decrementRemainingJobs(runId);
        if (isBatchComplete) {
          this.logger.log(`[VALIDATION-WORKER] Batch complete after bypass. Triggering matching...`);
          await this.matchingQueue.add('evaluate', discoveryPayload);
        }
        return { valid: true, bypassed: true };
      }

      // If valid and new, pass to Job Scraping Queue for deep anti-detect rendering
      this.logger.log(`[VALIDATION-WORKER] Job approved: "${job.title}" at "${job.company}". Sending to Scraping Enrichment...`);
      await this.scrapingQueue.add('scrape-job', {
        runId,
        discoveryPayload,
        job,
      });

      return { valid: true, bypassed: false };
    } catch (err) {
      this.logger.error(`[VALIDATION-WORKER] Exception validating job: ${err.message}`);
      // Decrement on failure to avoid pipeline freeze
      const isBatchComplete = this.coordinator.decrementRemainingJobs(runId);
      if (isBatchComplete) {
        await this.matchingQueue.add('evaluate', discoveryPayload);
      }
      throw err;
    }
  }
}
