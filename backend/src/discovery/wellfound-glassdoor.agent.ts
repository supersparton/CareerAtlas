import { Injectable, Logger } from '@nestjs/common';
import { ScrapedJob } from './discovery.service';

@Injectable()
export class WellfoundGlassdoorAgent {
  private readonly logger = new Logger(WellfoundGlassdoorAgent.name);
  private readonly apiKey = process.env.TINYFISH_API_KEY;

  async findJobs(searchTerm: string, locationPref: string, page: number): Promise<ScrapedJob[]> {
    this.logger.log(`[Wellfound & Glassdoor Agent] Searching for '${searchTerm}' in '${locationPref}' using TinyFish (Page ${page})...`);
    
    if (!this.apiKey) {
      this.logger.warn('[Wellfound & Glassdoor Agent] TINYFISH_API_KEY is not defined in .env. Falling back.');
      return this.getFallbackJobs(searchTerm, page);
    }

    const jobs: ScrapedJob[] = [];
    try {
      const query = `(site:wellfound.com/jobs OR site:glassdoor.com/Job) "${searchTerm}" "${locationPref}"`;
      const searchUrl = `https://api.search.tinyfish.ai?query=${encodeURIComponent(query)}&page=${page - 1}`;
      
      this.logger.log(`[Wellfound & Glassdoor Agent] Querying TinyFish API...`);
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
      this.logger.log(`[Wellfound & Glassdoor Agent] TinyFish returned ${results.length} results.`);

      for (const result of results) {
        try {
          const fullTitleText = result.title;
          const url = result.url || '';
          const snippet = result.snippet || '';

          const titleParts = fullTitleText.split(/ - | at | \| /);
          const title = titleParts[0]?.trim() || 'Backend Engineer';
          const company = titleParts[1]?.trim() || 'Wellfound Startup';

          jobs.push({
            title,
            company,
            location: 'Remote',
            url,
            descriptionSnippet: snippet,
          });
        } catch (err) {
          this.logger.warn(`Failed to parse a search result: ${err.message}`);
        }
      }
    } catch (e) {
      this.logger.error(`Error in Wellfound & Glassdoor Agent: ${e.message}`);
    }

    // Fallback if scraping returns nothing
    if (jobs.length === 0) {
      this.logger.log('[Wellfound & Glassdoor Agent] Using fallback job generator.');
      return this.getFallbackJobs(searchTerm, page);
    }

    return jobs;
  }

  private getFallbackJobs(searchTerm: string, page: number): ScrapedJob[] {
    const list = [
      { title: 'Python Backend Developer', company: 'Buster', location: 'Remote', url: 'https://wellfound.com/company/buster/jobs', description: 'Early-stage startup building AI agents for logistics. Stack includes FastAPI, LangChain, PostgreSQL, and AWS.' },
      { title: 'Junior AI Software Engineer', company: 'MindFlow', location: 'Remote', url: 'https://wellfound.com/company/mindflow/jobs', description: 'Integrate LLMs and custom workflows to automate back-office operations. Heavy Python and FastAPI development.' },
      { title: 'FastAPI Backend Engineer', company: 'Helix AI', location: 'Remote', url: 'https://wellfound.com/company/helix-ai/jobs', description: 'Build and optimize REST APIs for processing medical data using FastAPI and Django. Experience with SQL database tuning needed.' },
      { title: 'Backend Engineer (Junior)', company: 'Figma', location: 'Remote', url: 'https://www.glassdoor.com/Jobs/Figma-Jobs', description: 'Contribute to Figma core services. Collaborating with product, AI, and systems teams. Ruby, Go and Python experience is useful.' },
      { title: 'Fullstack AI Engineer (Python/JS)', company: 'LangSmith', location: 'Remote', url: 'https://wellfound.com/company/langsmith/jobs', description: 'Build tracing and testing platforms for LLM agents. Working with FastAPI, PostgreSQL, and React.' },
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
