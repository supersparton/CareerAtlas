  import { Injectable, Logger } from '@nestjs/common';
  import { DatabaseService } from '../vector-store/database.service';
  import { MemoryService } from '../memory/memory.service';
  import { Job } from '../discovery/discovery.service';
  import { QdrantService } from '../vector-store/qdrant.service';
  import { ROLE_ONTOLOGY, detectFamily, detectSubfamily } from 'src/matching/roleTaxonomy';
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
        if (searchTerm && !this.isJobRelevant(job.title, searchTerm)) {
          return { valid: false, reason: `Irrelevant title for search: "${searchTerm}"` };
        }

        // 6. Check if job already has vector embeddings in Qdrant
        const inQdrant = await this.isJobInQdrant(job.jobId);

        return { valid: true, bypassed: inQdrant };
      } catch (err) {
        this.logger.error(`[VALIDATION] Exception validating job "${job.title}": ${err.message}`);
        return { valid: false, reason: `Error: ${err.message}` };
      }
    }

    private readonly locationSynonyms: { [key: string]: string } = {
      'bangalore': 'bengaluru',
      'banglore': 'bengaluru',
      'bangalore urban': 'bengaluru',
      'bengaluru': 'bengaluru',
      'mumbai': 'mumbai',
      'bombay': 'mumbai',
      'new york': 'new york',
      'new york city': 'new york',
      'nyc': 'new york',
      'ny': 'new york',
      'san francisco': 'san francisco',
      'sf': 'san francisco',
      'bay area': 'san francisco'
    };

    private isJobRelevant(jobTitle: string, searchTerm: string): boolean {
      const titleLower = jobTitle.toLowerCase();
      const searchJobLower = searchTerm.toLowerCase();

      // Check negations first
      const irrelevantKeywords = ['sales', 'marketing', 'recruiter', 'hr', 'accountant', 'ticketing', 'travel', 'admin', 'writer', 'seo'];
      const hasNegative = irrelevantKeywords.some(neg => {
        return titleLower.includes(neg) && !searchJobLower.includes(neg);
      });
      if (hasNegative) {
        this.logger.log(`[VALIDATION] Title "${jobTitle}" rejected due to non-technical keyword`);
        return false;
      }

      const titleFamily = detectFamily(titleLower);
      const searchJobFamily = detectFamily(searchJobLower);

      // Add software engineering (family 'software') as generic opening
      if (titleFamily === 'software') {
        return true;
      }

      // If families match, it's relevant
      if (titleFamily === searchJobFamily && titleFamily !== null) {
        return true;
      }

      // If one of them is null, we can do a simple substring comparison fallback to be safe
      if (titleFamily === null || searchJobFamily === null) {
        // If search term is a substring of the title, let it pass
        if (titleLower.includes(searchJobLower) || searchJobLower.includes(titleLower)) {
          return true;
        }
      }

      this.logger.log(`[VALIDATION] Title "${jobTitle}" rejected due to family mismatch: titleFamily=${titleFamily}, searchFamily=${searchJobFamily}`);
      return false;
    }
   
    private normalizeLocation(loc: string): string {
      let l = loc.toLowerCase().trim();
      l = l.replace(/[^a-z0-9\s]/g, '');

      for (const [key, normalized] of Object.entries(this.locationSynonyms)) {
        if (l === key || l.includes(key)) {
          return normalized;
        }
      }
      return l;
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

      if (locations.length > 0) {
        const normJobLoc = this.normalizeLocation(jobLocation);
        const hasMatch = locations.some(loc => {
          const normPrefLoc = this.normalizeLocation(loc);
          return normJobLoc.includes(normPrefLoc) || normPrefLoc.includes(normJobLoc);
        });
        if (hasMatch) {
          return true;
        }
      }

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
