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

    private readonly roleAliases: { [key: string]: string[] } = {
      'software engineer': [
        'software engineer',
        'software developer',
        'sde',
        'sde i',
        'sde-ii',
        'sde-2',
        'sde-1',
        'sde-3',
        'sde iii',
        'senior software engineer',
        'junior software engineer',
        'application engineer',
        'member of technical staff',
        'mts',
        'technical staff member',
        'software development engineer'
      ],
      'backend engineer': [
        'backend engineer',
        'backend developer',
        'node.js developer',
        'node developer',
        'python backend developer',
        'python developer',
        'java developer',
        'java backend developer',
        'golang developer',
        'golang backend developer',
        'go developer',
        'c# developer',
        'dot net developer',
        '.net developer',
        'backend software engineer'
      ],
      'frontend engineer': [
        'frontend engineer',
        'frontend developer',
        'front-end developer',
        'front end developer',
        'react developer',
        'react.js developer',
        'vue developer',
        'angular developer',
        'ui engineer',
        'ui developer',
        'frontend software engineer'
      ],
      'fullstack engineer': [
        'fullstack engineer',
        'full stack developer',
        'full-stack developer',
        'full stack engineer',
        'fullstack developer'
      ],
      'data analyst': [
        'data analyst',
        'business analyst',
        'analytics engineer',
        'product analyst',
        'data analytics'
      ],
      'data engineer': [
        'data engineer',
        'data platform engineer',
        'big data engineer',
        'analytics engineer'
      ],
      'data scientist': [
        'data scientist',
        'machine learning engineer',
        'ml engineer',
        'ai engineer',
        'applied scientist'
      ],
      'devops engineer': [
        'devops engineer',
        'site reliability engineer',
        'sre',
        'platform engineer',
        'cloud engineer',
        'systems engineer'
      ],
      'product manager': [
        'product manager',
        'pm',
        'associate product manager',
        'technical product manager'
      ]
    };

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

    private computeStringSimilarity(str1: string, str2: string): { score: number; method: string } {
      const s1 = str1.toLowerCase().trim();
      const s2 = str2.toLowerCase().trim();

      if (s1 === s2) {
        return { score: 1.0, method: 'exact' };
      }

      // Check if they belong to the same alias group
      for (const [groupName, aliases] of Object.entries(this.roleAliases)) {
        const matchesS1 = aliases.some(alias => s1.includes(alias) || alias.includes(s1));
        const matchesS2 = aliases.some(alias => s2.includes(alias) || alias.includes(s2));
        if (matchesS1 && matchesS2) {
          const confidence = s1.includes('software') && s2.includes('sde') ? 0.95 : 0.92;
          return { score: confidence, method: 'alias mapping' };
        }
      }

      // Fallback: character bigram Dice's Coefficient
      const getBigrams = (str: string) => {
        const bigrams = new Set<string>();
        for (let i = 0; i < str.length - 1; i++) {
          bigrams.add(str.slice(i, i + 2));
        }
        return bigrams;
      };

      const b1 = getBigrams(s1);
      const b2 = getBigrams(s2);

      if (b1.size === 0 || b2.size === 0) {
        return { score: 0.0, method: 'bigram overlap' };
      }

      let intersection = 0;
      for (const b of b1) {
        if (b2.has(b)) {
          intersection++;
        }
      }

      const dice = (2.0 * intersection) / (b1.size + b2.size);
      const score = Math.round(dice * 100) / 100;
      return { score, method: 'fuzzy matching' };
    }

    private isTitleRelevant(jobTitle: string, searchTerm: string): boolean {
      const titleLower = jobTitle.toLowerCase();
      const searchLower = searchTerm.toLowerCase();

      // Check negations first
      const negativeKeywords = ['sales', 'marketing', 'recruiter', 'hr', 'accountant', 'ticketing', 'travel', 'admin', 'writer', 'seo'];
      const hasNegative = negativeKeywords.some(neg => {
        return titleLower.includes(neg) && !searchLower.includes(neg);
      });
      if (hasNegative) {
        this.logger.log(`[VALIDATION] Title "${jobTitle}" rejected due to negative keyword`);
        return false;
      }

      const { score, method } = this.computeStringSimilarity(jobTitle, searchTerm);

      if (score >= 0.50) {
        this.logger.log(`[VALIDATION] "${searchTerm}" matched "${jobTitle}" via ${method} | confidence = ${score}`);
        return true;
      }

      this.logger.log(`[VALIDATION] Title "${jobTitle}" rejected for search "${searchTerm}" (confidence = ${score})`);
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
