import { Injectable, Logger } from '@nestjs/common';

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
}

@Injectable()
export class PipelineCoordinatorService {
  private readonly logger = new Logger(PipelineCoordinatorService.name);
  private runs = new Map<string, PipelineRun>();
  private activeRunId: string | null = null;

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
  startRun(
    runId: string,
    userId: number,
    searchTerms: string[],
    locationSearch: string,
    limit: number,
    currentCycle = 1,
    maxCycles = 3,
    page = 1,
    accumulatedMatches: any[] = []
  ): PipelineRun {
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
    };

    this.runs.set(runId, run);
    this.activeRunId = runId;
    this.addLog(runId, `Starting workflow run for terms: [${searchTerms.join(', ')}] (Cycle ${currentCycle}/${maxCycles})`);
    return run;
  }

  /**
   * Retrieves a run by its ID.
   */
  getRun(runId: string): PipelineRun | undefined {
    return this.runs.get(runId);
  }

  /**
   * Retrieves the current active run status, or the default idle status.
   */
  getActiveRunStatus(): PipelineStatus {
    if (this.activeRunId) {
      const run = this.runs.get(this.activeRunId);
      if (run) {
        return run.status;
      }
    }
    return this.defaultStatus;
  }

  /**
   * Updates the status of a specific step in a run.
   */
  updateStep(runId: string, stepId: string, status: 'idle' | 'running' | 'success' | 'error', errorDetails = '') {
    const run = this.runs.get(runId);
    if (run && run.status.steps[stepId]) {
      run.status.steps[stepId].status = status;
      run.status.steps[stepId].errorDetails = errorDetails;
      this.logger.log(`[PIPELINE-COORDINATOR] Run ${runId} | Step ${stepId} updated to ${status}`);
    }
  }

  /**
   * Adds a timestamped log message to the run.
   */
  addLog(runId: string, message: string) {
    const run = this.runs.get(runId);
    if (run) {
      const timestamp = new Date().toLocaleTimeString();
      run.status.logs.unshift(`[${timestamp}] ${message}`);
      this.logger.log(`[PIPELINE-COORDINATOR] Run ${runId} | Log: ${message}`);
    }
  }

  /**
   * Sets the total number of child jobs for the current cycle.
   */
  setTotalJobs(runId: string, total: number) {
    const run = this.runs.get(runId);
    if (run) {
      run.totalJobs = total;
      run.processedJobs = 0;
      this.logger.log(`[PIPELINE-COORDINATOR] Run ${runId} | Expecting ${total} jobs to process.`);
    }
  }

  /**
   * Decrements the remaining jobs counter.
   * Returns true if all jobs in the current batch have finished processing.
   */
  decrementRemainingJobs(runId: string): boolean {
    const run = this.runs.get(runId);
    if (!run) return false;

    run.processedJobs++;
    const remaining = run.totalJobs - run.processedJobs;
    this.logger.log(`[PIPELINE-COORDINATOR] Run ${runId} | Progress: ${run.processedJobs}/${run.totalJobs} (Remaining: ${remaining})`);

    if (remaining <= 0) {
      this.logger.log(`[PIPELINE-COORDINATOR] Run ${runId} | All jobs processed for current cycle.`);
      return true;
    }
    return false;
  }

  /**
   * Marks a run as completed.
   */
  completeRun(runId: string, message = 'Workflow completed.') {
    const run = this.runs.get(runId);
    if (run) {
      run.status.active = false;
      this.addLog(runId, message);
      
      // Mark all non-error steps as success upon workflow completion
      for (const stepId of Object.keys(run.status.steps)) {
        if (run.status.steps[stepId].status !== 'error') {
          run.status.steps[stepId].status = 'success';
        }
      }
      
      this.logger.log(`[PIPELINE-COORDINATOR] Run ${runId} marked as completed.`);
    }
  }

  /**
   * Marks a run as failed.
   */
  failRun(runId: string, errorMsg: string) {
    const run = this.runs.get(runId);
    if (run) {
      run.status.active = false;
      this.addLog(runId, `Workflow failed: ${errorMsg}`);
      
      // Update any running steps to error
      for (const stepId of Object.keys(run.status.steps)) {
        if (run.status.steps[stepId].status === 'running') {
          run.status.steps[stepId].status = 'error';
          run.status.steps[stepId].errorDetails = errorMsg;
        }
      }
      this.logger.error(`[PIPELINE-COORDINATOR] Run ${runId} failed: ${errorMsg}`);
    }
  }
}
