import { Processor, WorkerHost, InjectQueue } from '@nestjs/bullmq';
import { Queue, Job as BullJob } from 'bullmq';
import { Logger } from '@nestjs/common';
import { JobIntelligenceService } from '../intelligence/job-intelligence.service';
import { PipelineCoordinatorService } from './pipeline-coordinator.service';
import { Job } from '../discovery/discovery.service';
import { extractTraceContext, injectTraceContext, tracer } from '../otel';
import { context } from '@opentelemetry/api';

interface IntelligenceJobPayload {
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

@Processor('job-intelligence', { concurrency: 3 }) // Balanced concurrency for LLM API keys
export class IntelligenceWorker extends WorkerHost {
  private readonly logger = new Logger(IntelligenceWorker.name);

  constructor(
    private readonly jobIntelligenceService: JobIntelligenceService,
    private readonly coordinator: PipelineCoordinatorService,
    @InjectQueue('job-embedding') private readonly embeddingQueue: Queue,
    @InjectQueue('job-matching') private readonly matchingQueue: Queue,
  ) {
    super();
  }

  async process(bullJob: BullJob<IntelligenceJobPayload>): Promise<any> {
    const parentCtx = extractTraceContext(bullJob.data);
    return await context.with(parentCtx, async () => {
      return await tracer.startActiveSpan('IntelligenceWorker.process', async (span) => {
        const { runId, discoveryPayload, job } = bullJob.data;

        span.setAttribute('run.id', runId);
        span.setAttribute('job.title', job.title);
        span.setAttribute('job.company', job.company);

        try {
          await this.coordinator.updateStep(runId, 'step-4', 'running');

          // Call the LLM requirements extraction
          const reqs = await this.jobIntelligenceService.extractRequirements(job);

          this.logger.log(`[INTELLIGENCE-WORKER] Extracted requirements for: "${job.title}" at "${job.company}"`);

          // Forward to Embedding Queue
          await this.embeddingQueue.add('embed-job', injectTraceContext({
            runId,
            discoveryPayload,
            job,
            requirements: reqs,
          }));

          span.setStatus({ code: 1 }); // OK
          return { success: true };
        } catch (err) {
          this.logger.error(`[INTELLIGENCE-WORKER] Failed to process job intelligence: ${err.message}`);
          span.recordException(err);
          span.setStatus({ code: 2, message: err.message });

          // Decrement on failure to prevent pipeline freeze
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
