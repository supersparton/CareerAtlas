import { Injectable, Logger } from '@nestjs/common';
import { chromium, Browser, Page } from 'playwright';

export interface ScrapedJob {
  title: string;
  company: string;
  location: string;
  url: string;
  descriptionSnippet: string;
}

@Injectable()
export class DiscoveryService {
  private readonly logger = new Logger(DiscoveryService.name);

  async scrapeLinkedInJobs(searchTerm: string, location: string): Promise<ScrapedJob[]> {
    this.logger.log(`Starting Playwright to scrape LinkedIn jobs for ${searchTerm} in ${location}...`);
    
    let browser: Browser | null = null;
    const jobs: ScrapedJob[] = [];

    try {
      browser = await chromium.launch({ headless: true });
      const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      });
      const page = await context.newPage();

      // Navigate to LinkedIn Jobs guest page (no login required for public searches)
      const url = `https://www.linkedin.com/jobs/search?keywords=${encodeURIComponent(searchTerm)}&location=${encodeURIComponent(location)}`;
      await page.goto(url, { waitUntil: 'domcontentloaded' });

      // Wait a moment for dynamic content
      await page.waitForTimeout(3000);

      // Extract job cards
      const jobCards = await page.$$('.jobs-search__results-list li');
      this.logger.log(`Found ${jobCards.length} job cards.`);

      for (let i = 0; i < Math.min(jobCards.length, 10); i++) { // Limit to 10 for safety
        const card = jobCards[i];
        try {
          const titleEl = await card.$('.base-search-card__title');
          const companyEl = await card.$('.base-search-card__subtitle');
          const locationEl = await card.$('.job-search-card__location');
          const urlEl = await card.$('.base-card__full-link');

          if (titleEl && companyEl) {
            const title = (await titleEl.innerText()).trim();
            const company = (await companyEl.innerText()).trim();
            const loc = locationEl ? (await locationEl.innerText()).trim() : '';
            const link = urlEl ? await urlEl.getAttribute('href') : '';

            jobs.push({
              title,
              company,
              location: loc,
              url: link || '',
              descriptionSnippet: `Job listing for ${title} at ${company} in ${loc}`
            });
          }
        } catch (e) {
          this.logger.warn(`Failed to parse a job card: ${e.message}`);
        }
      }

    } catch (e) {
      this.logger.error(`Error during LinkedIn scraping: ${e.message}`, e.stack);
    } finally {
      if (browser) {
        await browser.close();
      }
    }

    this.logger.log(`Successfully scraped ${jobs.length} jobs.`);
    return jobs;
  }
}
