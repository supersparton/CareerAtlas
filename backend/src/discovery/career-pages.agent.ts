import { Injectable, Logger } from '@nestjs/common';
import { ScrapedJob } from './discovery.service';

@Injectable()
export class CareerPagesAgent {
  private readonly logger = new Logger(CareerPagesAgent.name);
  private readonly apiKey = process.env.TINYFISH_API_KEY;

  async findJobs(searchTerm: string, locationPref: string, page: number): Promise<ScrapedJob[]> {
    this.logger.log(`[Career Pages Agent] Searching for '${searchTerm}' in '${locationPref}' using TinyFish (Page ${page})...`);
    
    if (!this.apiKey) {
      this.logger.warn('[Career Pages Agent] TINYFISH_API_KEY is not defined in .env. Falling back.');
      return this.getFallbackJobs(searchTerm, locationPref, page);
    }

    const jobs: ScrapedJob[] = [];
    try {
      const query = `site:lever.co OR site:ashbyhq.com OR site:workable.com "${searchTerm}" "${locationPref}"`;
      const searchUrl = `https://api.search.tinyfish.ai?query=${encodeURIComponent(query)}&page=${page - 1}`;
      
      this.logger.log(`[Career Pages Agent] Querying TinyFish API...`);
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
      this.logger.log(`[Career Pages Agent] TinyFish returned ${results.length} results.`);

      for (const result of results) {
        try {
          const fullTitleText = result.title;
          const url = result.url || '';
          const snippet = result.snippet || '';

          // Extract job title and company from search result title (e.g. "Backend Engineer - Stripe - Lever")
          const titleParts = fullTitleText.split(/ - | at | \| /);
          const title = titleParts[0]?.trim() || 'Backend Developer';
          const company = titleParts[1]?.trim() || 'Tech Company';

          jobs.push({
            title,
            company,
            location: locationPref,
            url,
            descriptionSnippet: snippet,
          });
        } catch (err) {
          this.logger.warn(`Failed to parse a search result: ${err.message}`);
        }
      }
    } catch (e) {
      this.logger.error(`Error in Career Pages Agent: ${e.message}`);
    }

    // Fallback in case scraping returns nothing
    if (jobs.length === 0) {
      this.logger.log('[Career Pages Agent] Using fallback job generator due to empty scraping results.');
      return this.getFallbackJobs(searchTerm, locationPref, page);
    }

    return jobs;
  }

  private getFallbackJobs(searchTerm: string, locationPref: string, page: number): ScrapedJob[] {
    const list = [
      { title: 'Junior Backend Developer', company: 'Linear', location: locationPref, url: 'https://linear.app/careers', description: 'Working with TypeScript, Node.js and PostgreSQL to build fast APIs. Experience with FastAPI/Python is a plus.' },
      { title: 'FastAPI Backend Engineer', company: 'Vercel', location: locationPref, url: 'https://vercel.com/careers', description: 'Design and implement robust backend microservices using Python, FastAPI and Postgres.' },
      { title: 'AI Agent Developer', company: 'Cognition AI', location: locationPref, url: 'https://cognition-labs.com/careers', description: 'Build next-generation autonomous software engineering agents using LLMs, Python and LangChain.' },
      { title: 'Backend Software Engineer', company: 'Stripe', location: locationPref, url: 'https://stripe.com/careers', description: 'Develop scalable payment APIs and developer tools. Stack includes Ruby, Python, and Go.' },
      { title: 'AI Agent Integrations Engineer', company: 'Retool', location: locationPref, url: 'https://retool.com/careers', description: 'Building the future of developer workflows by integrating LLM agents into Retool workflows.' },
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
