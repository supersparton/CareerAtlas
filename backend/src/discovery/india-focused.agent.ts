import { Injectable, Logger } from '@nestjs/common';
import { Job, generateJobId } from './discovery.service';

@Injectable()
export class IndiaFocusedAgent {
  private readonly logger = new Logger(IndiaFocusedAgent.name);
  private readonly apiKey = process.env.TINYFISH_API_KEY;

  private getDateFilter(): string {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const dateStr = thirtyDaysAgo.toISOString().split('T')[0];
    return `after:${dateStr}`;
  }

  async findJobs(searchTerm: string, locationPref: string, page: number): Promise<Job[]> {
    this.logger.log(`[SCRAPER: INDIA_FOCUSED] Searching for '${searchTerm}' in '${locationPref}' (Page ${page})...`);
    
    if (!this.apiKey) {
      this.logger.error('[SCRAPER: INDIA_FOCUSED] TINYFISH_API_KEY is not defined in .env. Skipping search.');
      return [];
    }

    // Broaden keyword queries specifically for Indian platforms where job titles vary
    let finalSearchTerm = `"${searchTerm}"`;
    if (searchTerm.toLowerCase().includes('backend')) {
      finalSearchTerm = `("Backend Software Engineer" OR "Backend Developer" OR "Software Developer" OR "Python Developer" OR "Node.js Developer")`;
    } else if (searchTerm.toLowerCase().includes('frontend')) {
      finalSearchTerm = `("Frontend Software Engineer" OR "Frontend Developer" OR "Software Developer" OR "React Developer")`;
    }

    const jobs: Job[] = [];
    try {
      const dateFilter = this.getDateFilter();
      
      // Try with date filter first
      let query = `(site:instahyre.com/job OR site:cutshort.io/job OR site:naukri.com/job-listings) ${finalSearchTerm} ${locationPref} ${dateFilter}`;
      let searchUrl = `https://api.search.tinyfish.ai?query=${encodeURIComponent(query)}&page=${page - 1}`;
      
      this.logger.log(`[SCRAPER: INDIA_FOCUSED] Querying TinyFish API (Attempt 1: With Date Filter) with query: "${query}"`);
      let response = await fetch(searchUrl, {
        method: 'GET',
        headers: { 'X-API-Key': this.apiKey },
      });

      if (!response.ok) {
        throw new Error(`TinyFish Search API responded with status ${response.status}`);
      }

      let data = await response.json();
      let results = data.results || [];

      // Fallback: if 0 results found, retry without date filter to capture undated/older active job posts
      if (results.length === 0 && page === 1) {
        this.logger.warn(`[SCRAPER: INDIA_FOCUSED] 0 results with date filter. Retrying without date filter for broader search...`);
        query = `(site:instahyre.com/job OR site:cutshort.io/job OR site:naukri.com/job-listings) ${finalSearchTerm} ${locationPref}`;
        searchUrl = `https://api.search.tinyfish.ai?query=${encodeURIComponent(query)}&page=${page - 1}`;
        
        response = await fetch(searchUrl, {
          method: 'GET',
          headers: { 'X-API-Key': this.apiKey },
        });
        if (response.ok) {
          data = await response.json();
          results = data.results || [];
        }
      }

      this.logger.log(`[SCRAPER: INDIA_FOCUSED] TinyFish returned ${results.length} results.`);

      for (const result of results) {
        try {
          const fullTitleText = result.title || '';
          const url = result.url || '';
          const snippet = result.snippet || '';

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

          const jobId = generateJobId('wellfound-glassdoor', company, title, url);
          jobs.push({
            jobId,
            source: 'wellfound-glassdoor',
            title,
            company,
            location: locationPref.replace(/[()"]/g, ''), // Clean location string
            applyUrl: url,
            description: snippet,
          });
        } catch (err) {
          this.logger.warn(`[SCRAPER: INDIA_FOCUSED] Failed to parse result: ${err.message}`);
        }
      }
    } catch (e) {
      this.logger.error(`[SCRAPER: INDIA_FOCUSED] Error: ${e.message}`);
    }

    return jobs;
  }
}
