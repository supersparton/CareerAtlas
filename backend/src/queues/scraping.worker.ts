import { Processor, WorkerHost, InjectQueue } from '@nestjs/bullmq';
import { Queue, Job as BullJob } from 'bullmq';
import { Logger } from '@nestjs/common';
import { CamoufoxScraperService } from '../intelligence/camoufox-scraper.service';
import { PipelineCoordinatorService } from './pipeline-coordinator.service';
import { Job } from '../discovery/discovery.service';
import { extractTraceContext, injectTraceContext, tracer } from '../otel';
import { context } from '@opentelemetry/api';

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
    @InjectQueue('job-matching') private readonly matchingQueue: Queue,
  ) {
    super();
  }

  async process(bullJob: BullJob<ScrapingJobPayload>): Promise<any> {
    const parentCtx = extractTraceContext(bullJob.data);
    return await context.with(parentCtx, async () => {
      return await tracer.startActiveSpan('ScrapingWorker.process', async (span) => {
        const { runId, discoveryPayload, job } = bullJob.data;

        span.setAttribute('run.id', runId);
        span.setAttribute('job.title', job.title);
        span.setAttribute('job.company', job.company);
        if (job.applyUrl) {
          span.setAttribute('job.apply_url', job.applyUrl);
        }

        try {
          await this.coordinator.updateStep(runId, 'step-4', 'running');
          await this.coordinator.addLog(runId, `Deep-scraping full details for "${job.title}" at "${job.company}" using anti-detect browser...`);

          let scrapedSuccessful = false;
          if (job.applyUrl) {
            const fullDesc = await this.camoufoxScraperService.scrapeUrl(job.applyUrl);
            if (fullDesc && fullDesc.length > 200) {
              // Post-scrape expiry check: discard if the scraped description indicates the role is closed/expired
              const expiredKeywords = /\b(hiring has ended|no longer accepting applications|this job has expired|role is closed)\b/i;
              if (expiredKeywords.test(fullDesc)) {
                this.logger.warn(`[SCRAPING-WORKER] Discarding job "${job.title}" at "${job.company}" - Scraped description indicates it is closed/expired.`);
                await this.coordinator.addLog(runId, `Discarded "${job.title}" at "${job.company}" - Role is closed/expired.`);
                span.setAttribute('job.scraped', false);
                span.setAttribute('job.discard_reason', 'closed_or_expired');
                const isBatchComplete = await this.coordinator.decrementRemainingJobs(runId);
                if (isBatchComplete) {
                  await this.matchingQueue.add('evaluate', injectTraceContext(discoveryPayload));
                }
                span.setStatus({ code: 1 }); // OK
                return { success: false, reason: 'Job is closed or expired' };
              }

              job.description = fullDesc;
              scrapedSuccessful = true;
              this.logger.log(`[SCRAPING-WORKER] Successfully enriched job description for "${job.title}"`);
              await this.coordinator.addLog(runId, `Enriched job description for "${job.title}" (${fullDesc.length} chars).`);
            }
          }

          const hasValidDescription = scrapedSuccessful || (job.description && job.description.length > 200);

          if (!hasValidDescription) {
            this.logger.warn(`[SCRAPING-WORKER] Discarding job "${job.title}" at "${job.company}" - Description scraping failed and no fallback description is available.`);
            await this.coordinator.addLog(runId, `Discarded "${job.title}" at "${job.company}" - failed to scrape description.`);
            span.setAttribute('job.scraped', false);
            span.setAttribute('job.discard_reason', 'scraping_failed');

            // Decrement remaining jobs counter
            const isBatchComplete = await this.coordinator.decrementRemainingJobs(runId);
            if (isBatchComplete) {
              this.logger.log(`[SCRAPING-WORKER] Batch complete after discarding invalid job. Triggering matching...`);
              await this.matchingQueue.add('evaluate', injectTraceContext(discoveryPayload));
            }
            span.setStatus({ code: 1 }); // OK
            return { success: false, reason: 'Failed to retrieve job description' };
          }

          span.setAttribute('job.scraped', true);
          // Forward to Job Intelligence Queue
          await this.intelligenceQueue.add('parse-job', injectTraceContext({
            runId,
            discoveryPayload,
            job,
          }));

          span.setStatus({ code: 1 }); // OK
          return { success: true };
        } catch (err) {
          this.logger.error(`[SCRAPING-WORKER] Error in scraping job: ${err.message}`);
          span.recordException(err);
          span.setStatus({ code: 2, message: err.message });

          // Fallback: Check if we still have a valid description before forwarding to prevent pipeline freeze
          const hasValidDescription = job.description && job.description.length > 200;
          if (hasValidDescription) {
            await this.intelligenceQueue.add('parse-job', injectTraceContext({
              runId,
              discoveryPayload,
              job,
            }));
          } else {
            const isBatchComplete = await this.coordinator.decrementRemainingJobs(runId);
            if (isBatchComplete) {
              await this.matchingQueue.add('evaluate', injectTraceContext(discoveryPayload));
            }
          }

          return { success: false, error: err.message };
        } finally {
          span.end();
        }
      });
    });
  }
}
