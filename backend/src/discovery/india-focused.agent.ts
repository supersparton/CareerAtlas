import { Injectable, Logger } from '@nestjs/common';
import { Job, generateJobId } from './discovery.service';

@Injectable()
export class IndiaFocusedAgent {
  private readonly logger = new Logger(IndiaFocusedAgent.name);

  private getApiKey(): string {
    const key = process.env.TINYFISH_API_KEY;
    if (!key) {
      throw new Error('[INDIA-FOCUSED] TINYFISH_API_KEY environment variable is required.');
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

  private expandLocationForQuery(location: string): string {
    const cleaned = location.replace(/[()"]/g, '').trim();
    const lower = cleaned.toLowerCase();
    if (lower === 'bangalore' || lower === 'bengaluru') {
      return '("Bangalore" OR "Bengaluru")';
    }
    return `"${cleaned}"`;
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
    this.logger.log(`[SCRAPER: INDIA_FOCUSED] Searching for '${searchTerm}' in '${locationPref}' (Page ${page}, Cycle ${currentCycle || 1}, Exp ${experienceYears !== undefined ? experienceYears : 'N/A'})...`);
    
    if (!this.getApiKey()) {
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
      const dateFilter = this.getDateFilter(currentCycle);
      const expandedLoc = this.expandLocationForQuery(locationPref);
      const modifier = experienceYears !== undefined ? ` ${this.getSeniorityQueryModifier(experienceYears)}` : '';
      
      // Try with date filter first
      let query = `(site:instahyre.com/job OR site:cutshort.io/job OR site:naukri.com/job-listings) ${finalSearchTerm}${modifier} ${expandedLoc} ${dateFilter}`;
      let searchUrl = `https://api.search.tinyfish.ai?query=${encodeURIComponent(query)}&page=${page - 1}`;
      
      this.logger.log(`[SCRAPER: INDIA_FOCUSED] Querying TinyFish API (Attempt 1: With Date + Seniority Filter) with query: "${query}"`);
      let response = await fetch(searchUrl, {
        method: 'GET',
        headers: { 'X-API-Key': this.getApiKey() },
        signal: AbortSignal.timeout(8000),
      });

      if (!response.ok) {
        throw new Error(`TinyFish Search API responded with status ${response.status}`);
      }

      let data = await response.json();
      let results = data.results || [];

      // Fallback 1: if 0 results found, retry without date filter to capture undated/older active job posts
      if (results.length === 0 && page === 1) {
        this.logger.warn(`[SCRAPER: INDIA_FOCUSED] 0 results. Retrying without date filter but keeping seniority...`);
        query = `(site:instahyre.com/job OR site:cutshort.io/job OR site:naukri.com/job-listings) ${finalSearchTerm}${modifier} ${expandedLoc}`;
        searchUrl = `https://api.search.tinyfish.ai?query=${encodeURIComponent(query)}&page=${page - 1}`;
        
        response = await fetch(searchUrl, {
          method: 'GET',
          headers: { 'X-API-Key': this.getApiKey() },
          signal: AbortSignal.timeout(8000),
        });
        if (response.ok) {
          data = await response.json();
          results = data.results || [];
        }
      }

      // Fallback 2: if still 0 results, retry without seniority modifiers to ensure search is not empty
      if (results.length === 0 && page === 1 && experienceYears !== undefined) {
        this.logger.warn(`[SCRAPER: INDIA_FOCUSED] 0 results. Retrying without seniority modifiers...`);
        query = `(site:instahyre.com/job OR site:cutshort.io/job OR site:naukri.com/job-listings) ${finalSearchTerm} ${expandedLoc}`;
        searchUrl = `https://api.search.tinyfish.ai?query=${encodeURIComponent(query)}&page=${page - 1}`;
        
        response = await fetch(searchUrl, {
          method: 'GET',
          headers: { 'X-API-Key': this.getApiKey() },
          signal: AbortSignal.timeout(8000),
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
