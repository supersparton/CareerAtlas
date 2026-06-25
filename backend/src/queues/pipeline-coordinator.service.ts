import { Injectable, Logger } from '@nestjs/common';
import { MemoryService } from '../memory/memory.service';

export interface PipelineStatus {
  active: boolean;
  steps: {
    [key: string]: { status: 'idle' | 'running' | 'success' | 'error'; errorDetails: string };
  };
  logs: string[];
}

export interface PipelineRun {
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
  totalJobs: number;
  processedJobs: number;
  status: PipelineStatus;
  startTime?: number;
}

@Injectable()
export class PipelineCoordinatorService {
  private readonly logger = new Logger(PipelineCoordinatorService.name);
  private runs = new Map<string, PipelineRun>();
  private activeRunId: string | null = null;

  constructor(private readonly memoryService: MemoryService) {}

  private get redis() {
    return this.memoryService.getRedisClient();
  }

  // Default status structure matching the existing AgentService status page
  private defaultStatus: PipelineStatus = {
    active: false,
    steps: {
      'step-1': { status: 'idle', errorDetails: '' }, // Profile sync
      'step-2': { status: 'idle', errorDetails: '' }, // Job Scrapers Ingestion
      'step-3': { status: 'idle', errorDetails: '' }, // Job Validation
      'step-4': { status: 'idle', errorDetails: '' }, // Job Intelligence Parsing
      'step-5': { status: 'idle', errorDetails: '' }, // Embedding Generation & Qdrant Upsert
      'step-6': { status: 'idle', errorDetails: '' }, // Recommendation matching
      'step-7': { status: 'idle', errorDetails: '' }, // Alerts dispatch
    },
    logs: [],
  };

  /**
   * Starts a new pipeline run.
   */
  async startRun(
    runId: string,
    userId: number,
    searchTerms: string[],
    locationSearch: string,
    limit: number,
    currentCycle = 1,
    maxCycles = 3,
    page = 1,
    accumulatedMatches: any[] = []
  ): Promise<PipelineRun> {
    const status = JSON.parse(JSON.stringify(this.defaultStatus));
    status.active = true;

    const run: PipelineRun = {
      runId,
      userId,
      searchTerms,
      activeTermIndex: 0,
      locationSearch,
      limit,
      currentCycle,
      maxCycles,
      page,
      accumulatedMatches,
      totalJobs: 0,
      processedJobs: 0,
      status,
      startTime: Date.now(),
    };

    if (this.redis) {
      try {
        await this.redis.set(`careeratlas:run:${runId}`, JSON.stringify(run), 'EX', 7200);
        await this.redis.set('careeratlas:active_run_id', runId, 'EX', 7200);
      } catch (err: any) {
        this.logger.error(`[PIPELINE-COORDINATOR] Redis startRun failed: ${err.message}`);
      }
    }
    this.runs.set(runId, run);
    this.activeRunId = runId;
    await this.addLog(runId, `Starting workflow run for terms: [${searchTerms.join(', ')}] (Cycle ${currentCycle}/${maxCycles})`);
    return run;
  }

  /**
   * Retrieves a run by its ID.
   */
  async getRun(runId: string): Promise<PipelineRun | undefined> {
    if (this.redis) {
      try {
        const val = await this.redis.get(`careeratlas:run:${runId}`);
        if (val) {
          return JSON.parse(val);
        }
      } catch (err: any) {
        this.logger.error(`[PIPELINE-COORDINATOR] Redis getRun failed: ${err.message}`);
      }
    }
    return this.runs.get(runId);
  }

  /**
   * Retrieves the current active run status, or the default idle status.
   */
  async getActiveRunStatus(): Promise<PipelineStatus> {
    let runId: string | null = this.activeRunId;
    if (this.redis) {
      try {
        const activeId = await this.redis.get('careeratlas:active_run_id');
        if (activeId) {
          runId = activeId;
        }
      } catch (err: any) {
        this.logger.error(`[PIPELINE-COORDINATOR] Redis active run ID get failed: ${err.message}`);
      }
    }

    if (runId) {
      const run = await this.getRun(runId);
      if (run) {
        return run.status;
      }
    }
    return this.defaultStatus;
  }

  /**
   * Updates the status of a specific step in a run.
   */
  async updateStep(runId: string, stepId: string, status: 'idle' | 'running' | 'success' | 'error', errorDetails = '') {
    const run = await this.getRun(runId);
    if (run && run.status.steps[stepId]) {
      run.status.steps[stepId].status = status;
      run.status.steps[stepId].errorDetails = errorDetails;
      if (this.redis) {
        try {
          await this.redis.set(`careeratlas:run:${runId}`, JSON.stringify(run), 'EX', 7200);
        } catch (err: any) {
          this.logger.error(`[PIPELINE-COORDINATOR] Redis updateStep failed: ${err.message}`);
        }
      }
      this.runs.set(runId, run);
      this.logger.log(`[PIPELINE-COORDINATOR] Run ${runId} | Step ${stepId} updated to ${status}`);
    }
  }

  /**
   * Adds a timestamped log message to the run.
   */
  async addLog(runId: string, message: string) {
    const run = await this.getRun(runId);
    if (run) {
      const timestamp = new Date().toLocaleTimeString();
      run.status.logs.unshift(`[${timestamp}] ${message}`);
      if (this.redis) {
        try {
          await this.redis.set(`careeratlas:run:${runId}`, JSON.stringify(run), 'EX', 7200);
        } catch (err: any) {
          this.logger.error(`[PIPELINE-COORDINATOR] Redis addLog failed: ${err.message}`);
        }
      }
      this.runs.set(runId, run);
      this.logger.log(`[PIPELINE-COORDINATOR] Run ${runId} | Log: ${message}`);
    }
  }

  /**
   * Sets the total number of child jobs for the current cycle.
   */
  async setTotalJobs(runId: string, total: number) {
    if (this.redis) {
      try {
        await this.redis.set(`careeratlas:run:${runId}:processed_jobs`, 0, 'EX', 7200);
      } catch (err: any) {
        this.logger.error(`[PIPELINE-COORDINATOR] Redis setTotalJobs counter reset failed: ${err.message}`);
      }
    }
    const run = await this.getRun(runId);
    if (run) {
      run.totalJobs = total;
      run.processedJobs = 0;
      if (this.redis) {
        try {
          await this.redis.set(`careeratlas:run:${runId}`, JSON.stringify(run), 'EX', 7200);
        } catch (err: any) {
          this.logger.error(`[PIPELINE-COORDINATOR] Redis setTotalJobs save failed: ${err.message}`);
        }
      }
      this.runs.set(runId, run);
      this.logger.log(`[PIPELINE-COORDINATOR] Run ${runId} | Expecting ${total} jobs to process.`);
    }
  }

  /**
   * Decrements the remaining jobs counter.
   * Returns true if all jobs in the current batch have finished processing.
   */
  async decrementRemainingJobs(runId: string): Promise<boolean> {
    let processed = 0;
    if (this.redis) {
      try {
        processed = await this.redis.incr(`careeratlas:run:${runId}:processed_jobs`);
        await this.redis.expire(`careeratlas:run:${runId}:processed_jobs`, 7200);
      } catch (err: any) {
        this.logger.error(`[PIPELINE-COORDINATOR] Redis decrementRemainingJobs incr failed: ${err.message}`);
      }
    }

    const run = await this.getRun(runId);
    if (!run) return false;

    if (!this.redis) {
      run.processedJobs++;
      processed = run.processedJobs;
    } else {
      run.processedJobs = processed;
    }

    const remaining = run.totalJobs - processed;

    if (this.redis) {
      try {
        await this.redis.set(`careeratlas:run:${runId}`, JSON.stringify(run), 'EX', 7200);
      } catch (err: any) {
        this.logger.error(`[PIPELINE-COORDINATOR] Redis decrementRemainingJobs save failed: ${err.message}`);
      }
    }
    this.runs.set(runId, run);

    this.logger.log(`[PIPELINE-COORDINATOR] Run ${runId} | Progress: ${processed}/${run.totalJobs} (Remaining: ${remaining})`);

    if (remaining <= 0) {
      this.logger.log(`[PIPELINE-COORDINATOR] Run ${runId} | All jobs processed for current cycle.`);
      return true;
    }
    return false;
  }

  /**
   * Marks a run as completed.
   */
  async completeRun(runId: string, message = 'Workflow completed.') {
    const run = await this.getRun(runId);
    if (run) {
      run.status.active = false;
      const durationMs = run.startTime ? Date.now() - run.startTime : 0;
      const durationSeconds = (durationMs / 1000).toFixed(2);
      const timeMessage = `${message} (Took ${durationSeconds}s)`;

      const timestamp = new Date().toLocaleTimeString();
      run.status.logs.unshift(`[${timestamp}] ${timeMessage}`);

      // Mark all non-error steps as success upon workflow completion
      for (const stepId of Object.keys(run.status.steps)) {
        if (run.status.steps[stepId].status !== 'error') {
          run.status.steps[stepId].status = 'success';
        }
      }

      if (this.redis) {
        try {
          await this.redis.set(`careeratlas:run:${runId}`, JSON.stringify(run), 'EX', 7200);
        } catch (err: any) {
          this.logger.error(`[PIPELINE-COORDINATOR] Redis completeRun failed: ${err.message}`);
        }
      }
      this.runs.set(runId, run);
      this.logger.log(`[PIPELINE-COORDINATOR] Run ${runId} | Log: ${timeMessage}`);
      this.logger.log(`[PIPELINE-COORDINATOR] Run ${runId} marked as completed. Took ${durationSeconds}s.`);
    }
  }

  /**
   * Marks a run as failed.
   */
  async failRun(runId: string, errorMsg: string) {
    const run = await this.getRun(runId);
    if (run) {
      run.status.active = false;
      const durationMs = run.startTime ? Date.now() - run.startTime : 0;
      const durationSeconds = (durationMs / 1000).toFixed(2);
      const timeMessage = `Workflow failed: ${errorMsg} (Took ${durationSeconds}s)`;

      const timestamp = new Date().toLocaleTimeString();
      run.status.logs.unshift(`[${timestamp}] ${timeMessage}`);

      // Update any running steps to error
      for (const stepId of Object.keys(run.status.steps)) {
        if (run.status.steps[stepId].status === 'running') {
          run.status.steps[stepId].status = 'error';
          run.status.steps[stepId].errorDetails = errorMsg;
        }
      }

      if (this.redis) {
        try {
          await this.redis.set(`careeratlas:run:${runId}`, JSON.stringify(run), 'EX', 7200);
        } catch (err: any) {
          this.logger.error(`[PIPELINE-COORDINATOR] Redis failRun failed: ${err.message}`);
        }
      }
      this.runs.set(runId, run);
      this.logger.log(`[PIPELINE-COORDINATOR] Run ${runId} | Log: ${timeMessage}`);
      this.logger.error(`[PIPELINE-COORDINATOR] Run ${runId} failed: ${errorMsg}. Took ${durationSeconds}s.`);
    }
  }
}
