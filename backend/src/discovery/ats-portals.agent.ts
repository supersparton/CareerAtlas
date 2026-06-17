import { Injectable, Logger } from '@nestjs/common';
import { Job, generateJobId } from './discovery.service';

@Injectable()
export class AtsPortalsAgent {
  private readonly logger = new Logger(AtsPortalsAgent.name);
  private readonly apiKey = process.env.TINYFISH_API_KEY;

  private getDateFilter(): string {
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const dateStr = sevenDaysAgo.toISOString().split('T')[0];
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

  async findJobs(searchTerm: string, locationPref: string, page: number): Promise<Job[]> {
    this.logger.log(`[SCRAPER: ATS_PORTALS] Searching for '${searchTerm}' in '${locationPref}' (Page ${page})...`);
    
    if (!this.apiKey) {
      this.logger.error('[SCRAPER: ATS_PORTALS] TINYFISH_API_KEY is not defined in .env. Skipping search.');
      return [];
    }

    const jobs: Job[] = [];
    try {
      const dateFilter = this.getDateFilter();
      const expandedLoc = this.expandLocationForQuery(locationPref);
      const query = `(site:boards.greenhouse.io OR site:lever.co OR site:ashbyhq.com OR site:workable.com) "${searchTerm}" ${expandedLoc} ${dateFilter}`;
      const searchUrl = `https://api.search.tinyfish.ai?query=${encodeURIComponent(query)}&page=${page - 1}`;
      
      this.logger.log(`[SCRAPER: ATS_PORTALS] Querying TinyFish API with query: "${query}"`);
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
      this.logger.log(`[SCRAPER: ATS_PORTALS] TinyFish returned ${results.length} results.`);

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

          const jobId = generateJobId('career-pages', company, title, url);
          jobs.push({
            jobId,
            source: 'career-pages',
            title,
            company,
            location: locationPref.replace(/[()"]/g, ''), // Clean location string
            applyUrl: url,
            description: snippet,
          });
        } catch (err) {
          this.logger.warn(`[SCRAPER: ATS_PORTALS] Failed to parse result: ${err.message}`);
        }
      }
    } catch (e) {
      this.logger.error(`[SCRAPER: ATS_PORTALS] Error: ${e.message}`);
    }

    return jobs;
  }
}
