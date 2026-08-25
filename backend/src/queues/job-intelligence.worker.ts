import { Processor, WorkerHost, InjectQueue } from '@nestjs/bullmq';
import { Queue, Job as BullJob } from 'bullmq';
import { Logger, OnApplicationBootstrap } from '@nestjs/common';
import { JobIntelligenceService } from '../intelligence/job-intelligence.service';
import { PipelineCoordinatorService } from './pipeline-coordinator.service';
import { Job } from '../discovery/discovery.service';
import { LlmGatewayService } from '../llm-gateway/llm-gateway.service';

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
export class IntelligenceWorker extends WorkerHost implements OnApplicationBootstrap {
  private readonly logger = new Logger(IntelligenceWorker.name);

  constructor(
    private readonly jobIntelligenceService: JobIntelligenceService,
    private readonly coordinator: PipelineCoordinatorService,
    @InjectQueue('job-embedding') private readonly embeddingQueue: Queue,
    @InjectQueue('job-matching') private readonly matchingQueue: Queue,
    private readonly llmGatewayService: LlmGatewayService,
  ) {
    super();
  }

  onApplicationBootstrap() {
    const count = this.llmGatewayService.getLlmInstancesCount();
    if (count > 0) {
      this.worker.concurrency = count;
      this.logger.log(`[INTELLIGENCE-WORKER] Dynamically set concurrency to ${count} based on active LLM instances`);
    } else {
      this.logger.warn(`[INTELLIGENCE-WORKER] No active LLM instances found in LlmGatewayService, keeping default concurrency of 3`);
    }
  }

  async process(bullJob: BullJob<IntelligenceJobPayload>): Promise<any> {
    const intelStart = Date.now();
    const { runId, discoveryPayload, job } = bullJob.data;

    try {
      await this.coordinator.updateStep(runId, 'step-4', 'running');

      // Call the LLM requirements extraction
      const reqs = await this.jobIntelligenceService.extractRequirements(job);
      const intelMs = Date.now() - intelStart;

      this.logger.log(`[LATENCY] [job-intelligence] Extracted requirements in ${intelMs}ms for: "${job.title}" at "${job.company}"`);

      // Forward to Embedding Queue
      await this.embeddingQueue.add('embed-job', {
        runId,
        discoveryPayload,
        job,
        requirements: reqs,
      });

      return { success: true };
    } catch (err) {
      const intelMs = Date.now() - intelStart;
      this.logger.error(`[LATENCY-ERROR] [job-intelligence] Intelligence stage failed after ${intelMs}ms for "${job.title}": ${err.message}`);
      
      // Decrement on failure to prevent pipeline freeze — do NOT re-throw to avoid BullMQ retry double-decrement
      const isBatchComplete = await this.coordinator.decrementRemainingJobs(runId);
      if (isBatchComplete) {
        await this.matchingQueue.add('evaluate', discoveryPayload);
      }
    }
  }
}
