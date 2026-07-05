import { Processor, WorkerHost, InjectQueue } from '@nestjs/bullmq';
import { Queue, Job as BullJob } from 'bullmq';
import { Logger } from '@nestjs/common';
import { ValidationService } from '../validation/validation.service';
import { ProfileService } from '../profile/profile.service';
import { PipelineCoordinatorService } from './pipeline-coordinator.service';
import { Job } from '../discovery/discovery.service';
import { extractTraceContext, injectTraceContext, tracer } from '../otel';
import { context } from '@opentelemetry/api';

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
    const parentCtx = extractTraceContext(bullJob.data);
    return await context.with(parentCtx, async () => {
      return await tracer.startActiveSpan('ValidationWorker.process', async (span) => {
        const { runId, discoveryPayload, job } = bullJob.data;

        span.setAttribute('run.id', runId);
        span.setAttribute('job.title', job.title);
        span.setAttribute('job.company', job.company);

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
            span.setAttribute('job.validated', false);
            span.setAttribute('job.discard_reason', validationResult.reason || '');

            // Decrement remaining jobs counter
            const isBatchComplete = await this.coordinator.decrementRemainingJobs(runId);
            if (isBatchComplete) {
              this.logger.log(`[VALIDATION-WORKER] Batch complete after discard. Triggering matching...`);
              await this.matchingQueue.add('evaluate', injectTraceContext(discoveryPayload));
            }
            span.setStatus({ code: 1 }); // OK
            return { valid: false, reason: validationResult.reason };
          }

          // If bypassed (job already exists in Qdrant store), skip LLM and Embedding extraction completely
          if (validationResult.bypassed) {
            this.logger.log(`[VALIDATION-WORKER] Job "${job.title}" already exists in Qdrant (semantic store). Bypassing Intelligence & Embedding layers.`);
            span.setAttribute('job.validated', true);
            span.setAttribute('job.bypassed', true);
            await this.coordinator.addLog(runId, `Bypassed Intelligence & Embedding for "${job.title}" at ${job.company} (already indexed).`);

            const isBatchComplete = await this.coordinator.decrementRemainingJobs(runId);
            if (isBatchComplete) {
              this.logger.log(`[VALIDATION-WORKER] Batch complete after bypass. Triggering matching...`);
              await this.matchingQueue.add('evaluate', injectTraceContext(discoveryPayload));
            }
            span.setStatus({ code: 1 }); // OK
            return { valid: true, bypassed: true };
          }

          // If valid and new, pass to Job Scraping Queue for deep anti-detect rendering
          this.logger.log(`[VALIDATION-WORKER] Job approved: "${job.title}" at "${job.company}". Sending to Scraping Enrichment...`);
          span.setAttribute('job.validated', true);
          span.setAttribute('job.bypassed', false);
          await this.scrapingQueue.add('scrape-job', injectTraceContext({
            runId,
            discoveryPayload,
            job,
          }));

          span.setStatus({ code: 1 }); // OK
          return { valid: true, bypassed: false };
        } catch (err) {
          this.logger.error(`[VALIDATION-WORKER] Exception validating job: ${err.message}`);
          span.recordException(err);
          span.setStatus({ code: 2, message: err.message });
          // Decrement on failure to avoid pipeline freeze
          const isBatchComplete = await this.coordinator.decrementRemainingJobs(runId);
          if (isBatchComplete) {
            await this.matchingQueue.add('evaluate', injectTraceContext(discoveryPayload));
          }
          throw err;
        } finally {
          span.end();
        }
      });
    });
  }
}
