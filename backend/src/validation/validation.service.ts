import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../vector-store/database.service';
import { MemoryService } from '../memory/memory.service';
import { Job } from '../discovery/discovery.service';

@Injectable()
export class ValidationService {
  private readonly logger = new Logger(ValidationService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly memoryService: MemoryService
  ) {}

  /**
   * Validates a batch of scraped jobs. Filters out duplicates, expired jobs, and broken links.
   * Returns only validated jobs.
   */
  async validateJobs(jobs: Job[]): Promise<Job[]> {
    this.logger.log(`[VALIDATION] Running validation checks on ${jobs.length} jobs...`);
    const validatedJobs: Job[] = [];

    // Run URL validation in parallel for speed
    const validationPromises = jobs.map(async (job) => {
      try {
        // 1. Check Duplicates (both DB and local seen memory)
        const isDupe = await this.isDuplicate(job);
        if (isDupe) {
          return { job, valid: false, reason: 'Duplicate' };
        }

        // 2. Check Expiry (dynamic freshness bounds)
        const isExpired = this.isExpired(job);
        if (isExpired) {
          return { job, valid: false, reason: 'Expired' };
        }

        // 3. Check Broken URL (fast check)
        const isUrlActive = await this.isUrlActive(job.applyUrl);
        if (!isUrlActive) {
          return { job, valid: false, reason: 'Broken Link' };
        }

        return { job, valid: true };
      } catch (err) {
        this.logger.error(`[VALIDATION] Exception validating job "${job.title}": ${err.message}`);
        return { job, valid: false, reason: `Error: ${err.message}` };
      }
    });

    const results = await Promise.all(validationPromises);
    
    for (const res of results) {
      if (res.valid) {
        validatedJobs.push(res.job);
      } else {
        this.logger.log(`[VALIDATION] ❌ Rejected: "${res.job.title}" at "${res.job.company}" (${res.reason})`);
      }
    }

    this.logger.log(`[VALIDATION] Validation complete. ${validatedJobs.length} / ${jobs.length} jobs approved.`);
    return validatedJobs;
  }

  private async isDuplicate(job: Job): Promise<boolean> {
    // Check local MemoryService (for backward-compatibility with seen_jobs.json files)
    if (this.memoryService.isJobProcessed(job.company, job.title, job.location, job.source)) {
      return true;
    }
    
    // Check DB
    try {
      const res = await this.db.query(
        'SELECT 1 FROM jobs WHERE id = $1 OR (LOWER(title) = LOWER($2) AND LOWER(company) = LOWER($3) AND LOWER(location) = LOWER($4))',
        [job.jobId, job.title, job.company, job.location]
      );
      return res.rows.length > 0;
    } catch (err) {
      this.logger.error(`[VALIDATION] DB duplicate check failed: ${err.message}`);
      return false;
    }
  }

  private isExpired(job: Job): boolean {
    // JDs with clear "expired/closed" language in body
    const expiredKeywords = /\b(hiring has ended|no longer accepting applications|this job has expired|role is closed)\b/i;
    if (expiredKeywords.test(job.description)) {
      return true;
    }
    return false;
  }

  private async isUrlActive(url: string): Promise<boolean> {
    if (!url || !url.startsWith('http')) {
      return false;
    }

    try {
      // Use AbortController to set a strict 2.5-second timeout so URL checking doesn't hang the loop
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2500);

      const response = await fetch(url, {
        method: 'HEAD',
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        },
      });

      clearTimeout(timeoutId);

      // Return true if HTTP status is OK or Redirect (2xx/3xx)
      return response.status >= 200 && response.status < 400;
    } catch (err) {
      // If HEAD fails, fallback to GET with a 2-second timeout as some sites block HEAD requests
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 2000);

        const response = await fetch(url, {
          method: 'GET',
          signal: controller.signal,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
          },
        });

        clearTimeout(timeoutId);
        return response.status >= 200 && response.status < 400;
      } catch (getErr) {
        this.logger.warn(`[VALIDATION] URL connection check failed for: ${url} (${getErr.message})`);
        return false;
      }
    }
  }
}
