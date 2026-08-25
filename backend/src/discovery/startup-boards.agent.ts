import { Injectable, Logger } from '@nestjs/common';
import { Job, generateJobId } from './discovery.service';

@Injectable()
export class StartupBoardsAgent {
  private readonly logger = new Logger(StartupBoardsAgent.name);

  private getApiKey(): string {
    const key = process.env.TINYFISH_API_KEY;
    if (!key) {
      throw new Error('[STARTUP-BOARDS] TINYFISH_API_KEY environment variable is required.');
    }
    return key;
  }

  private getDateFilter(currentCycle = 1): string {
    const days = currentCycle === 1 ? 7 : currentCycle === 2 ? 14 : 30;
    const pastDate = new Date();
    pastDate.setDate(pastDate.getDate() - days);
    const dateStr = pastDate.toISOString().split('T')[0];
    return `after:${dateStr}`;
  }

  private isCatalogUrl(url: string): boolean {
    const lower = url.toLowerCase();
    
    // YC catalog filters: Real YC job URLs contain '/company/' or '/companies/'
    if (lower.includes('ycombinator.com')) {
      if (!lower.includes('/company/') && !lower.includes('/companies/')) {
        return true;
      }
    }
    
    // Wellfound catalog filters: Catalog/search listing URLs contain /l/, /role/, /jobs/india, etc.
    if (lower.includes('wellfound.com')) {
      if (
        lower.includes('/jobs/l/') || 
        lower.includes('/jobs/role/') || 
        lower.includes('/jobs/p/') ||
        /\/jobs\/(india|remote|bangalore|delhi|mumbai|pune|hyderabad|noida|gurgaon|ahmedabad)/i.test(lower)
      ) {
        return true;
      }
    }
    
    return false;
  }

  private getSeniorityQueryModifier(experienceYears: number): string {
    if (experienceYears < 2) {
      return '(junior OR fresher OR associate OR intern OR "sde 1" OR "sde-1" OR "entry-level" OR graduate)';
    } else if (experienceYears >= 2 && experienceYears < 5) {
      return '(mid OR "sde 2" OR "sde-2" OR developer OR engineer)';
    } else if (experienceYears >= 5 && experienceYears < 8) {
      return '(senior OR sr OR "sde 3" OR "sde-3")';
    } else {
      return '(lead OR staff OR principal OR architect OR manager OR director OR vp)';
    }
  }

  async findJobs(searchTerm: string, locationPref: string, page: number, currentCycle?: number, experienceYears?: number): Promise<Job[]> {
    this.logger.log(`[SCRAPER: STARTUP_BOARDS] Searching for '${searchTerm}' in '${locationPref}' (Page ${page}, Cycle ${currentCycle || 1}, Exp ${experienceYears !== undefined ? experienceYears : 'N/A'})...`);
    
    if (!this.getApiKey()) {
      this.logger.error('[SCRAPER: STARTUP_BOARDS] TINYFISH_API_KEY is not defined in .env. Skipping search.');
      return [];
    }

    const jobs: Job[] = [];
    try {
      const dateFilter = this.getDateFilter(currentCycle);
      
      let finalLocation = locationPref;
      const cleanedLoc = locationPref.replace(/[()"]/g, '').trim().toLowerCase();
      if (cleanedLoc === 'bangalore' || cleanedLoc === 'bengaluru') {
        finalLocation = '("Bangalore" OR "Bengaluru" OR "India" OR "Remote")';
      } else if (!cleanedLoc.includes('india') && !cleanedLoc.includes('remote')) {
        finalLocation = `("${cleanedLoc}" OR "India" OR "Remote")`;
      }

      const modifier = experienceYears !== undefined ? ` ${this.getSeniorityQueryModifier(experienceYears)}` : '';
      const query = `(site:ycombinator.com/jobs OR site:wellfound.com/jobs) "${searchTerm}"${modifier} ${finalLocation} ${dateFilter}`;
      let searchUrl = `https://api.search.tinyfish.ai?query=${encodeURIComponent(query)}&page=${page - 1}`;
      
      this.logger.log(`[SCRAPER: STARTUP_BOARDS] Querying TinyFish API with query: "${query}"`);
      let response = await fetch(searchUrl, {
        method: 'GET',
        headers: {
          'X-API-Key': this.getApiKey(),
        },
        signal: AbortSignal.timeout(8000),
      });

      if (!response.ok) {
        throw new Error(`TinyFish Search API responded with status ${response.status}`);
      }

      let data = await response.json();
      let results = data.results || [];

      // Fallback: If 0 results found with seniority modifiers, retry query without seniority modifiers
      if (results.length === 0 && page === 1 && experienceYears !== undefined) {
        this.logger.log(`[SCRAPER: STARTUP_BOARDS] 0 results found with seniority modifier. Retrying query without seniority modifiers...`);
        const queryWithoutSeniority = `(site:ycombinator.com/jobs OR site:wellfound.com/jobs) "${searchTerm}" ${finalLocation} ${dateFilter}`;
        const fallbackUrl = `https://api.search.tinyfish.ai?query=${encodeURIComponent(queryWithoutSeniority)}&page=${page - 1}`;
        
        response = await fetch(fallbackUrl, {
          method: 'GET',
          headers: { 'X-API-Key': this.getApiKey() },
          signal: AbortSignal.timeout(8000),
        });
        if (response.ok) {
          data = await response.json();
          results = data.results || [];
        }
      }

      this.logger.log(`[SCRAPER: STARTUP_BOARDS] TinyFish returned ${results.length} results.`);

      for (const result of results) {
        try {
          const fullTitleText = result.title || '';
          const url = result.url || '';
          const snippet = result.snippet || '';

          if (this.isCatalogUrl(url)) {
            this.logger.log(`[SCRAPER: STARTUP_BOARDS] Skipping catalog/listing index URL: ${url}`);
            continue;
          }

          let title = 'Backend Engineer';
          let company = 'Company';

          if (fullTitleText.toLowerCase().includes('hiring')) {
            const parts = fullTitleText.split(/ hiring /i);
            company = parts[0]?.trim() || 'Company';
            title = parts[1]?.split(/ - | \| /)[0]?.trim() || 'Backend Engineer';
          } else if (fullTitleText.toLowerCase().includes('job at')) {
            const parts = fullTitleText.split(/ job at /i);
            title = parts[0]?.trim() || 'Backend Engineer';
            company = parts[1]?.split(/ - | \| /)[0]?.trim() || 'Company';
          } else {
            const parts = fullTitleText.split(/ - | at | \| | Job, /i);
            title = parts[0]?.trim() || 'Backend Engineer';
            company = parts[1]?.trim() || 'Company';
          }

          const jobId = generateJobId('yc-greenhouse', company, title, url);
          jobs.push({
            jobId,
            source: 'yc-greenhouse',
            title,
            company,
            location: locationPref.replace(/[()"]/g, ''), // Clean location string
            applyUrl: url,
            description: snippet,
          });
        } catch (err) {
          this.logger.warn(`[SCRAPER: STARTUP_BOARDS] Failed to parse result: ${err.message}`);
        }
      }
    } catch (e) {
      this.logger.error(`[SCRAPER: STARTUP_BOARDS] Error: ${e.message}`);
    }

    return jobs;
  }
}
