import { Processor, WorkerHost, InjectQueue } from '@nestjs/bullmq';
import { Queue, Job as BullJob } from 'bullmq';
import { Logger } from '@nestjs/common';
import { JobIntelligenceService } from '../intelligence/job-intelligence.service';
import { PipelineCoordinatorService } from './pipeline-coordinator.service';
import { Job } from '../discovery/discovery.service';

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
    const { runId, discoveryPayload, job } = bullJob.data;

    try {
      this.coordinator.updateStep(runId, 'step-4', 'running');

      // Call the LLM requirements extraction
      const reqs = await this.jobIntelligenceService.extractRequirements(job);

      this.logger.log(`[INTELLIGENCE-WORKER] Extracted requirements for: "${job.title}" at "${job.company}"`);

      // Forward to Embedding Queue
      await this.embeddingQueue.add('embed-job', {
        runId,
        discoveryPayload,
        job,
        requirements: reqs,
      });

      return { success: true };
    } catch (err) {
      this.logger.error(`[INTELLIGENCE-WORKER] Failed to process job intelligence: ${err.message}`);
      
      // Decrement on failure to prevent pipeline freeze
      const isBatchComplete = this.coordinator.decrementRemainingJobs(runId);
      if (isBatchComplete) {
        await this.matchingQueue.add('evaluate', discoveryPayload);
      }
      throw err;
    }
  }
}
