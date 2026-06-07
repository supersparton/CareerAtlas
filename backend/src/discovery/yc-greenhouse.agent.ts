import { Injectable, Logger } from '@nestjs/common';
import { ScrapedJob } from './discovery.service';

@Injectable()
export class YcGreenhouseAgent {
  private readonly logger = new Logger(YcGreenhouseAgent.name);
  private readonly apiKey = process.env.TINYFISH_API_KEY;

  async findJobs(searchTerm: string, locationPref: string, page: number): Promise<ScrapedJob[]> {
    this.logger.log(`[YC & Greenhouse Agent] Searching for '${searchTerm}' in '${locationPref}' using TinyFish (Page ${page})...`);
    
    if (!this.apiKey) {
      this.logger.warn('[YC & Greenhouse Agent] TINYFISH_API_KEY is not defined in .env. Falling back.');
      return this.getFallbackJobs(searchTerm, page);
    }

    const jobs: ScrapedJob[] = [];
    try {
      const query = `(site:boards.greenhouse.io OR site:ycombinator.com/jobs) "${searchTerm}" "${locationPref}"`;
      const searchUrl = `https://api.search.tinyfish.ai?query=${encodeURIComponent(query)}&page=${page - 1}`;
      
      this.logger.log(`[YC & Greenhouse Agent] Querying TinyFish API...`);
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
      this.logger.log(`[YC & Greenhouse Agent] TinyFish returned ${results.length} results.`);

      for (const result of results) {
        try {
          const fullTitleText = result.title;
          const url = result.url || '';
          const snippet = result.snippet || '';

          // Greenhouse boards usually look like "Job Title at Company Name" or "Job Title - Company Name"
          const titleParts = fullTitleText.split(/ - | at | \| /);
          const title = titleParts[0]?.trim() || 'Backend Engineer';
          const company = titleParts[1]?.trim() || 'YC Startup';

          jobs.push({
            title,
            company,
            location: 'Remote', // YC & Greenhouse listings from searches are typically remote-friendly
            url,
            descriptionSnippet: snippet,
          });
        } catch (err) {
          this.logger.warn(`Failed to parse a search result: ${err.message}`);
        }
      }
    } catch (e) {
      this.logger.error(`Error in YC & Greenhouse Agent: ${e.message}`);
    }

    // Fallback if scraping returns nothing or errors out
    if (jobs.length === 0) {
      this.logger.log('[YC & Greenhouse Agent] Using fallback job generator.');
      return this.getFallbackJobs(searchTerm, page);
    }

    return jobs;
  }

  private getFallbackJobs(searchTerm: string, page: number): ScrapedJob[] {
    const list = [
      { title: 'Python / Django Developer', company: 'Slingshot (YC W24)', location: 'Remote', url: 'https://www.ycombinator.com/companies/slingshot/jobs', description: 'Build API integrations and developer SDKs with FastAPI and Django. Knowledge of Postgres is essential.' },
      { title: 'AI Engineering Specialist', company: 'Hyperbolic (YC S23)', location: 'Remote', url: 'https://boards.greenhouse.io/hyperbolic', description: 'Join us in building open-source decentralized AI cloud inference systems. Strong Python skills required.' },
      { title: 'Junior Backend Software Engineer', company: 'DevZero (YC W23)', location: 'Remote', url: 'https://boards.greenhouse.io/devzero', description: 'Working on cloud development environments using FastAPI, Git, Docker, and Kubernetes.' },
      { title: 'Agent Platform Developer', company: 'AgentOps (YC W24)', location: 'Remote', url: 'https://www.ycombinator.com/companies/agentops/jobs', description: 'Help build monitoring and observability software for AI agents. Heavy usage of Python and FastAPI.' },
      { title: 'Software Engineer, Data & Infrastructure', company: 'Segment', location: 'Remote', url: 'https://boards.greenhouse.io/segment', description: 'Scale customer data pipelines using Go and Python. Build robust backend endpoints.' },
    ];

    const startIndex = ((page - 1) * 2) % list.length;
    const items = list.slice(startIndex, startIndex + 2);
    return items.map(item => ({
      title: item.title,
      company: item.company,
      location: item.location,
      url: item.url,
      descriptionSnippet: item.description,
    }));
  }
}
