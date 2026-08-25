import { Processor, WorkerHost, InjectQueue } from '@nestjs/bullmq';
import { Queue, Job as BullJob } from 'bullmq';
import { Logger } from '@nestjs/common';
import { EmbeddingsService } from '../embeddings/embeddings.service';
import { JobIntelligenceService, JobRequirements } from '../intelligence/job-intelligence.service';
import { MemoryService } from '../memory/memory.service';
import { PipelineCoordinatorService } from './pipeline-coordinator.service';
import { Job } from '../discovery/discovery.service';

interface EmbeddingJobPayload {
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
  requirements: JobRequirements;
}

@Processor('job-embedding', { concurrency: 5 }) // Run embeddings in parallel
export class EmbeddingWorker extends WorkerHost {
  private readonly logger = new Logger(EmbeddingWorker.name);

  constructor(
    private readonly embeddingsService: EmbeddingsService,
    private readonly jobIntelligenceService: JobIntelligenceService,
    private readonly memoryService: MemoryService,
    private readonly coordinator: PipelineCoordinatorService,
    @InjectQueue('job-matching') private readonly matchingQueue: Queue,
  ) {
    super();
  }

  async process(bullJob: BullJob<EmbeddingJobPayload>): Promise<any> {
    const embeddingStart = Date.now();
    const { runId, discoveryPayload, job, requirements } = bullJob.data;

    try {
      await this.coordinator.updateStep(runId, 'step-5', 'running');

      // Generate job description embedding text
      const textToEmbed = `Job Title: ${job.title}\nCompany: ${job.company}\nLocation: ${requirements.location}\nRequired Skills: ${requirements.requiredSkills.join(', ')}\nDescription: ${job.description}`;
      this.logger.log(`[EMBEDDING-WORKER] Generating Job Embedding for ID: ${job.jobId}`);
      
      const genStart = Date.now();
      const embedding = await this.embeddingsService.generateEmbedding(textToEmbed);
      const genMs = Date.now() - genStart;

      // Save job details and embedding to Qdrant
      const qdrantStart = Date.now();
      await this.jobIntelligenceService.saveJobToDb(job, requirements, embedding);
      const qdrantMs = Date.now() - qdrantStart;

      // Mark as processed in local MemoryService cache
      await this.memoryService.markJobAsProcessed(job.company, job.title, job.location, job.source);

      const totalMs = Date.now() - embeddingStart;
      this.logger.log(
        `[LATENCY] [job-embedding] Embedding stage completed in ${totalMs}ms ` +
        `(Vector Generation: ${genMs}ms, Qdrant Upsert: ${qdrantMs}ms) for "${job.title}"`
      );

      // Decrement the remaining jobs counter in coordinator
      const isBatchComplete = await this.coordinator.decrementRemainingJobs(runId);
      if (isBatchComplete) {
        this.logger.log(`[EMBEDDING-WORKER] Batch complete. Triggering matching queue evaluation for run: ${runId}`);
        await this.matchingQueue.add('evaluate', discoveryPayload);
      }

      return { success: true };
    } catch (err) {
      const totalMs = Date.now() - embeddingStart;
      this.logger.error(`[LATENCY-ERROR] [job-embedding] Failed to embed and save job after ${totalMs}ms: ${err.message}`);
      
      // Decrement on failure to prevent pipeline freeze — do NOT re-throw to avoid BullMQ retry double-decrement
      const isBatchComplete = await this.coordinator.decrementRemainingJobs(runId);
      if (isBatchComplete) {
        await this.matchingQueue.add('evaluate', discoveryPayload);
      }
    }
  }
}
