import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DatabaseService } from '../vector-store/database.service';
import { Job } from '../discovery/discovery.service';
import { QdrantService } from '../vector-store/qdrant.service';
import { EmbeddingsService } from '../embeddings/embeddings.service';

export interface ValidationCheckResult {
  valid: boolean;
  reason?: string;
  bypassed?: boolean;
}

@Injectable()
export class ValidationService implements OnModuleInit {
  private readonly logger = new Logger(ValidationService.name);
  private readonly apiKey = process.env.TINYFISH_API_KEY;
  private client: any = null;

  async onModuleInit() {
    try {
      // Dynamic import via new Function to load ESM-only @tiny-fish/sdk from CJS context.
      // This is safe because the specifier is a hardcoded string literal, not user input.
      const dynamicImport = new Function('specifier', 'return import(specifier)');
      const sdk = await dynamicImport('@tiny-fish/sdk');
      const TinyFish = sdk.TinyFish;
      this.client = new TinyFish({ apiKey: this.apiKey });
      this.logger.log('[VALIDATION] TinyFish SDK client loaded dynamically.');
    } catch (err: any) {
      this.logger.error(`[VALIDATION] Failed to dynamically load TinyFish SDK: ${err.message}`);
    }
  }

  constructor(
    private readonly db: DatabaseService,
    private readonly qdrantService: QdrantService,
    private readonly embeddingsService: EmbeddingsService,
  ) {}

  /**
   * Bulk check if multiple jobs are already present in PostgreSQL user results table.
   */
  async isJobInUserResultsBatch(userId: number, jobIds: string[]): Promise<Set<string>> {
    const existing = new Set<string>();
    if (!jobIds || jobIds.length === 0) return existing;

    try {
      const res = await this.db.query(
        'SELECT job_id FROM results WHERE user_id = $1 AND job_id = ANY($2)',
        [userId, jobIds]
      );
      for (const row of res.rows) {
        if (row.job_id) {
          existing.add(row.job_id);
        }
      }
    } catch (err: any) {
      this.logger.error(`[VALIDATION] DB batch check for user results failed: ${err.message}`);
    }
    return existing;
  }

  /**
   * Bulk check if multiple jobs already exist in Qdrant vector store with SUCCESS extraction.
   */
  async isJobInQdrantBatch(jobIds: string[]): Promise<Set<string>> {
    const existingUuids = new Set<string>();
    if (!jobIds || jobIds.length === 0) return existingUuids;

    try {
      const uuids = jobIds.map(id => QdrantService.stringToUuid(id));

      const res = await this.qdrantService.getClient().retrieve('job_embeddings', {
        ids: uuids,
        with_payload: true,
        with_vector: false,
      });

      for (const point of res) {
        const payload = point.payload as any;
        if (payload && payload.extractionStatus === 'SUCCESS') {
          existingUuids.add(String(point.id));
        }
      }
    } catch (err: any) {
      this.logger.error(`[VALIDATION] Qdrant bulk check failed: ${err.message}`);
    }
    return existingUuids;
  }

  /**
   * Bulk expiry check for a list of jobs, chunking TinyFish API requests.
   */
  async isExpiredBatch(jobs: Job[], chunkSize = 5): Promise<Map<string, boolean>> {
    const expiredMap = new Map<string, boolean>();
    if (!jobs || jobs.length === 0) return expiredMap;

    const expiredKeywords = /\b(hiring has ended|no longer accepting applications|this job has expired|role is closed)\b/i;

    const needsDeepCheck: Job[] = [];

    // Step 1: In-memory snippet & major portal check
    for (const job of jobs) {
      if (job.description && expiredKeywords.test(job.description)) {
        expiredMap.set(job.jobId, true);
        continue;
      }

      const urlLower = (job.applyUrl || '').toLowerCase();
      const isKnownPortal =
        urlLower.includes('greenhouse.io') ||
        urlLower.includes('lever.co') ||
        urlLower.includes('ashbyhq.com') ||
        urlLower.includes('instahyre.com') ||
        urlLower.includes('cutshort.io') ||
        urlLower.includes('naukri.com') ||
        urlLower.includes('workable.com') ||
        urlLower.includes('ycombinator.com') ||
        urlLower.includes('wellfound.com');

      // If snippet is fresh (>200 chars) with no expired keywords or from trusted portal, mark active
      if ((job.description && job.description.length > 200) || isKnownPortal) {
        expiredMap.set(job.jobId, false);
      } else {
        needsDeepCheck.push(job);
      }
    }

    if (needsDeepCheck.length === 0 || !this.client) {
      if (!this.client) {
        this.logger.warn('[VALIDATION] TinyFish client unavailable — marking jobs needing deep expiry check as expired (fail-closed)');
      }
      for (const job of needsDeepCheck) {
        // Fail-closed: if SDK unavailable, mark unknown jobs as expired to prevent stale data
        expiredMap.set(job.jobId, !this.client);
      }
      return expiredMap;
    }

    // Step 2: Chunked TinyFish SDK getContents requests
    for (let i = 0; i < needsDeepCheck.length; i += chunkSize) {
      const chunk = needsDeepCheck.slice(i, i + chunkSize);
      const urls = chunk.map(j => j.applyUrl).filter(Boolean);

      if (urls.length === 0) continue;

      try {
        const content = await this.client.fetch.getContents({ urls });

        const errorUrls = new Set<string>();
        if (content.errors && content.errors.length > 0) {
          for (const err of content.errors) {
            if (err.error.includes('404') || err.error.toLowerCase().includes('not found')) {
              errorUrls.add(err.url);
            }
          }
        }

        const validResultsMap = new Map<string, string>();
        if (content.results) {
          for (const res of content.results) {
            if (res && res.url && typeof res.text === 'string') {
              validResultsMap.set(res.url, res.text);
            }
          }
        }

        for (const job of chunk) {
          if (errorUrls.has(job.applyUrl)) {
            expiredMap.set(job.jobId, true);
          } else {
            const fetchedText = validResultsMap.get(job.applyUrl) || '';
            if (fetchedText.length === 0 || expiredKeywords.test(fetchedText)) {
              expiredMap.set(job.jobId, true);
            } else {
              expiredMap.set(job.jobId, false);
            }
          }
        }
      } catch (err: any) {
        this.logger.error(`[VALIDATION] TinyFish batch getContents failed: ${err.message}`);
        // Fail-closed: mark jobs as expired when API fails rather than letting stale data through
        for (const job of chunk) {
          expiredMap.set(job.jobId, true);
        }
      }
    }

    return expiredMap;
  }

  /**
   * High-performance 3-stage non-blocking batch validation for an array of jobs.
   */
  async validateBatch(
    jobs: Job[],
    searchTerm: string,
    profile: any,
    userId: number
  ): Promise<Map<string, ValidationCheckResult>> {
    const batchStart = Date.now();
    const resultMap = new Map<string, ValidationCheckResult>();

    if (!jobs || jobs.length === 0) return resultMap;

    try {
      // Stage 1: DB User Results Duplicate Check
      const dbStart = Date.now();
      const jobIds = jobs.map(j => j.jobId);
      const userResultDuplicates = await this.isJobInUserResultsBatch(userId, jobIds);
      const dbMs = Date.now() - dbStart;

      const nonDuplicateJobs: Job[] = [];
      for (const job of jobs) {
        if (userResultDuplicates.has(job.jobId)) {
          resultMap.set(job.jobId, { valid: false, reason: 'Duplicate (Already matched to this user)' });
        } else {
          nonDuplicateJobs.push(job);
        }
      }

      if (nonDuplicateJobs.length === 0) {
        const totalMs = Date.now() - batchStart;
        this.logger.log(
          `[LATENCY-DETAIL] [job-validation-batch] Batch of ${jobs.length} jobs validated in ${totalMs}ms (All ${jobs.length} were DB duplicates)`
        );
        return resultMap;
      }

      // Stage 2: Qdrant Bulk Existence Check
      const qdrantStart = Date.now();
      const nonDupJobIds = nonDuplicateJobs.map(j => j.jobId);
      const indexedQdrantUuids = await this.isJobInQdrantBatch(nonDupJobIds);
      const qdrantMs = Date.now() - qdrantStart;

      const existingInQdrantJobs: Job[] = [];
      for (const job of nonDuplicateJobs) {
        const uuid = QdrantService.stringToUuid(job.jobId);
        const inQdrant = indexedQdrantUuids.has(uuid);
        if (inQdrant) {
          existingInQdrantJobs.push(job);
        } else {
          // Immediately validate new jobs right after Stage 2 so they return immediately without waiting for or being blocked by expiry checks
          resultMap.set(job.jobId, { valid: true, bypassed: false });
        }
      }

      // Stage 3: Expiry Check ONLY for jobs present in Qdrant (inQdrant === true)
      let expiryMs = 0;
      if (existingInQdrantJobs.length > 0) {
        const expiryStart = Date.now();
        const expiredMap = await this.isExpiredBatch(existingInQdrantJobs);
        expiryMs = Date.now() - expiryStart;

        for (const job of existingInQdrantJobs) {
          const isExpired = expiredMap.get(job.jobId) === true;
          if (isExpired) {
            resultMap.set(job.jobId, { valid: false, reason: 'Expired' });
          } else {
            resultMap.set(job.jobId, { valid: true, bypassed: true });
          }
        }
      }

      const totalMs = Date.now() - batchStart;
      this.logger.log(
        `[LATENCY-DETAIL] [job-validation-batch] Batch of ${jobs.length} jobs validated in ${totalMs}ms ` +
          `(DB Dup Check: ${dbMs}ms, Qdrant Bulk Check: ${qdrantMs}ms, Expiry Check: ${expiryMs}ms)`
      );

      return resultMap;
    } catch (err: any) {
      this.logger.error(`[VALIDATION] Exception in validateBatch: ${err.message}`);
      // Fail-closed: mark all unprocessed jobs as invalid rather than letting stale data through
      for (const job of jobs) {
        if (!resultMap.has(job.jobId)) {
          resultMap.set(job.jobId, { valid: false, reason: `Validation error: ${err.message}` });
        }
      }
      return resultMap;
    }
  }

  /**
   * Single-item job validation call directly using validateBatch.
   */
  // async validateSingleJob(
  //   job: Job,
  //   searchTerm: string,
  //   profile: any,
  //   userId: number
  // ): Promise<ValidationCheckResult> {
  //   const batchMap = await this.validateBatch([job], searchTerm, profile, userId);
  //   return batchMap.get(job.jobId) || { valid: false, reason: 'Unknown validation failure' };
  // }
}
