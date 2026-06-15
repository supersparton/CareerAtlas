import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../vector-store/database.service';
import { MemoryService } from '../memory/memory.service';
import { Job } from '../discovery/discovery.service';
import { QdrantService } from '../vector-store/qdrant.service';

@Injectable()
export class ValidationService {
  private readonly logger = new Logger(ValidationService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly memoryService: MemoryService,
    private readonly qdrantService: QdrantService,
  ) {}

  /**
   * Validates a batch of scraped jobs. Filters out duplicates, expired jobs, broken links,
   * irrelevant titles, and location mismatches.
   * Returns only validated jobs.
   */
  async validateJobs(jobs: Job[], searchTerm?: string, profile?: any): Promise<Job[]> {
    this.logger.log(`[VALIDATION] Running validation checks on ${jobs.length} jobs...`);
    const validatedJobs: Job[] = [];
    const chunkSize = 5;

    for (let i = 0; i < jobs.length; i += chunkSize) {
      const chunk = jobs.slice(i, i + chunkSize);
      
      const validationPromises = chunk.map(async (job) => {
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

          // 4. Check Title Relevance
          if (searchTerm && !this.isTitleRelevant(job.title, searchTerm)) {
            return { job, valid: false, reason: `Irrelevant title for search: "${searchTerm}"` };
          }

          // 5. Check Location Relevance
          if (profile && !this.isLocationRelevant(job.location, profile)) {
            return { job, valid: false, reason: `Location "${job.location}" doesn't match candidate preferences` };
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
    }

    this.logger.log(`[VALIDATION] Validation complete. ${validatedJobs.length} / ${jobs.length} jobs approved.`);
    return validatedJobs;
  }

  private isTitleRelevant(jobTitle: string, searchTerm: string): boolean {
    const titleLower = jobTitle.toLowerCase();
    const searchLower = searchTerm.toLowerCase();

    // 1. Exact or partial substring match
    if (titleLower.includes(searchLower) || searchLower.includes(titleLower)) {
      return true;
    }

    const normTitle = jobTitle.toLowerCase().replace(/[^a-z0-9]/g, '');

    // 2. Extract key terms from search term (ignoring general words)
    const searchWords = searchLower
      .split(/[\s\-/,()]+/)
      .map(w => w.trim())
      .filter(w => w.length > 2 && w !== 'developer' && w !== 'engineer' && w !== 'job' && w !== 'intern' && w !== 'role');

    if (searchWords.length > 0) {
      // Check if the normalized job title contains at least one of the normalized search words
      const matchesSearchWord = searchWords.some(word => {
        const normWord = word.replace(/[^a-z0-9]/g, '');
        return normTitle.includes(normWord);
      });
      if (!matchesSearchWord) {
        return false;
      }
    }

    // 3. Negations: If the job title contains negative keywords like "sales", "hr", "marketing", "manager"
    const negativeKeywords = ['sales', 'marketing', 'recruiter', 'hr', 'accountant', 'ticketing', 'travel', 'admin', 'writer', 'seo'];
    const hasNegative = negativeKeywords.some(neg => {
      // Only reject if the search term does NOT contain this negative keyword
      return titleLower.includes(neg) && !searchLower.includes(neg);
    });

    if (hasNegative) {
      return false;
    }

    return true;
  }

  private isLocationRelevant(jobLocation: string, profile: any): boolean {
    if (!profile || !profile.preferences) {
      return true;
    }
    
    const locations = profile.preferences.locations || [];
    const isRemoteOpen = profile.preferences.remote ?? true;
    
    const jobLocLower = jobLocation.toLowerCase();
    
    // If the job is remote, and the candidate is open to remote, it's valid
    const isJobRemote = jobLocLower.includes('remote');
    if (isJobRemote && isRemoteOpen) {
      return true;
    }
    
    // If candidate has specific physical location preferences
    if (locations.length > 0) {
      const hasMatch = locations.some(loc => {
        const locLower = loc.toLowerCase();
        return jobLocLower.includes(locLower) || locLower.includes(jobLocLower);
      });
      if (hasMatch) {
        return true;
      }
    }
    
    // If candidate wants remote, and job is remote (handled above), or candidate is open to any location (locations is empty)
    if (locations.length === 0 && isRemoteOpen) {
      return true;
    }
    
    return false;
  }

  private async isDuplicate(job: Job): Promise<boolean> {
    // Check local MemoryService (for backward-compatibility with seen_jobs.json files)
    if (this.memoryService.isJobProcessed(job.company, job.title, job.location, job.source)) {
      return true;
    }
    
    // Check Qdrant vector store
    try {
      const uuid = QdrantService.stringToUuid(job.jobId);
      const res = await this.qdrantService.getClient().retrieve('job_embeddings', {
        ids: [uuid],
        with_payload: false,
        with_vector: false,
      });
      return res.length > 0;
    } catch (err) {
      this.logger.error(`[VALIDATION] Qdrant duplicate check failed: ${err.message}`);
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
