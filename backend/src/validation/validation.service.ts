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
    ) { }


    async isJobInUserResults(userId: number, jobId: string): Promise<boolean> {
      try {
        const res = await this.db.query(
          'SELECT id FROM results WHERE user_id = $1 AND job_id = $2',
          [userId, jobId]
        );
        return res.rows.length > 0;
      } catch (err) {
        this.logger.error(`[VALIDATION] DB check for user results duplicate failed: ${err.message}`);
        return false;
      }
    }

    async isJobInQdrant(jobId: string): Promise<boolean> {
      try {
        const uuid = QdrantService.stringToUuid(jobId);
        const res = await this.qdrantService.getClient().retrieve('job_embeddings', {
          ids: [uuid],
          with_payload: false,
          with_vector: false,
        });
        return res.length > 0;
      } catch (err) {
        this.logger.error(`[VALIDATION] Qdrant check for job embedding existence failed: ${err.message}`);
        return false;
      }
    }

    async validateSingleJob(job: Job, searchTerm: string, profile: any, userId: number): Promise<{ valid: boolean; reason?: string; bypassed?: boolean }> {
      try {
        // 1. Check if the user has already seen/notified this job
        const isAlreadyInUserResult = await this.isJobInUserResults(userId, job.jobId);
        if (isAlreadyInUserResult) {
          return { valid: false, reason: 'Duplicate (Already matched to this user)' };
        }

        // 2. Check Expiry
        const isExpired = this.isExpired(job);
        if (isExpired) {
          return { valid: false, reason: 'Expired' };
        }

        // 3. Check Broken URL
        const isUrlActive = await this.isUrlActive(job.applyUrl);
        if (!isUrlActive) {
          return { valid: false, reason: 'Broken Link' };
        }

        // 4. Check Title Relevance
        if (searchTerm && !this.isTitleRelevant(job.title, searchTerm)) {
          return { valid: false, reason: `Irrelevant title for search: "${searchTerm}"` };
        }

        // 5. Check Location Relevance
        if (profile && !this.isLocationRelevant(job.location, profile)) {
          return { valid: false, reason: `Location "${job.location}" doesn't match candidate preferences` };
        }

        // 6. Check if job already has vector embeddings in Qdrant
        const inQdrant = await this.isJobInQdrant(job.jobId);

        return { valid: true, bypassed: inQdrant };
      } catch (err) {
        this.logger.error(`[VALIDATION] Exception validating job "${job.title}": ${err.message}`);
        return { valid: false, reason: `Error: ${err.message}` };
      }
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
          const locLower = loc.toLowerCase().trim();
          if (jobLocLower.includes(locLower) || locLower.includes(jobLocLower)) {
            return true;
          }
          // Bangalore <-> Bengaluru synonym resolution
          const isBangalore = (s: string) => s.includes('bangalore') || s.includes('bengaluru');
          if (isBangalore(jobLocLower) && isBangalore(locLower)) {
            return true;
          }
          return false;
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

      // Specially bypass URL active check for major job platforms that aggressively block simple HTTP requests
      const urlLower = url.toLowerCase();
      if (
        urlLower.includes('linkedin.com') ||
        urlLower.includes('wellfound.com') ||
        urlLower.includes('ycombinator.com') ||
        urlLower.includes('glassdoor') ||
        urlLower.includes('indeed.com')
      ) {
        return true;
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
