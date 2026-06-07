import { Injectable, Logger } from '@nestjs/common';
import { Job, generateJobId } from './discovery.service';

@Injectable()
export class StartupBoardsAgent {
  private readonly logger = new Logger(StartupBoardsAgent.name);
  private readonly apiKey = process.env.TINYFISH_API_KEY;

  private getDateFilter(): string {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const dateStr = thirtyDaysAgo.toISOString().split('T')[0];
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

  async findJobs(searchTerm: string, locationPref: string, page: number): Promise<Job[]> {
    this.logger.log(`[SCRAPER: STARTUP_BOARDS] Searching for '${searchTerm}' in '${locationPref}' (Page ${page})...`);
    
    if (!this.apiKey) {
      this.logger.error('[SCRAPER: STARTUP_BOARDS] TINYFISH_API_KEY is not defined in .env. Skipping search.');
      return [];
    }

    const jobs: Job[] = [];
    try {
      const dateFilter = this.getDateFilter();
      
      let finalLocation = locationPref;
      if (!locationPref.toLowerCase().includes('india') && !locationPref.toLowerCase().includes('remote')) {
        finalLocation = `(${locationPref} OR "India" OR "Remote")`;
      }

      const query = `(site:ycombinator.com/jobs OR site:wellfound.com/jobs) "${searchTerm}" ${finalLocation} ${dateFilter}`;
      const searchUrl = `https://api.search.tinyfish.ai?query=${encodeURIComponent(query)}&page=${page - 1}`;
      
      this.logger.log(`[SCRAPER: STARTUP_BOARDS] Querying TinyFish API with query: "${query}"`);
      const response = await fetch(searchUrl, {
        method: 'GET',
        headers: {
          'X-API-Key': this.apiKey,
        },
      });

      if (!response.ok) {
        throw new Error(`TinyFish Search API responded with status ${response.status}`);
      }

      const data = await response.json();
      const results = data.results || [];
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
