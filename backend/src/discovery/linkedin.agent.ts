import { Injectable, Logger } from '@nestjs/common';
import { chromium, Browser, BrowserContext, Page } from 'playwright';
import { Job, generateJobId } from './discovery.service';

@Injectable()
export class LinkedInAgent {
  private readonly logger = new Logger(LinkedInAgent.name);

  // Load credentials from environment
  private readonly username = process.env.LINKEDIN_USERNAME;
  private readonly password = process.env.LINKEDIN_PASSWORD;
  private readonly headless = process.env.SCRAPER_HEADLESS !== 'false';

  async findJobs(searchTerm: string, locationPref: string, pageNum: number): Promise<Job[]> {
    this.logger.log(`[SCRAPER: LINKEDIN] Searching for '${searchTerm}' in '${locationPref}' (Page ${pageNum})...`);

    const jobs: Job[] = [];
    let browser: Browser | null = null;
    let context: BrowserContext | null = null;

    try {
      // 1. Launch browser with typical human config
      browser = await chromium.launch({
        headless: this.headless,
        args: [
          '--disable-blink-features=AutomationControlled',
          '--disable-infobars',
          '--window-size=1920,1080',
        ],
      });

      context = await browser.newContext({
        viewport: { width: 1920, height: 1080 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        locale: 'en-US',
        timezoneId: 'America/New_York',
      });

      // 2. Inject advanced browser anonymization to bypass detection
      await this.injectAnonymization(context);

      const page = await context.newPage();
      page.setDefaultTimeout(30000);

      // 3. Handle login if credentials are provided
      let isLoggedIn = false;
      if (this.username && this.password) {
        isLoggedIn = await this.attemptLogin(page, this.username, this.password);
      } else {
        this.logger.log('[LinkedIn Agent] No credentials found. Scraping in Guest mode.');
      }

      // Clean locationPref for LinkedIn: LinkedIn doesn't support Boolean OR queries (e.g. ("Bangalore" OR "Remote")) in its location field.
      let cleanLocation = locationPref;
      if (locationPref.includes(' OR ')) {
        const matches = locationPref.match(/"([^"]+)"/g);
        if (matches && matches.length > 0) {
          const nonRemote = matches.map(m => m.replace(/"/g, '')).find(m => m.toLowerCase() !== 'remote');
          cleanLocation = nonRemote || matches[0].replace(/"/g, '');
        } else {
          cleanLocation = locationPref.split(' OR ')[0].replace(/[()"]/g, '').trim();
        }
      } else {
        cleanLocation = locationPref.replace(/[()"]/g, '').trim();
      }

      // Determine the regional subdomain to bypass the public authwall redirection (e.g., in.linkedin.com)
      let subdomain = 'www';
      const locLower = cleanLocation.toLowerCase();
      if (
        locLower.includes('india') ||
        locLower.includes('bangalore') ||
        locLower.includes('bengaluru') ||
        locLower.includes('ahmedabad') ||
        locLower.includes('noida') ||
        locLower.includes('delhi') ||
        locLower.includes('mumbai') ||
        locLower.includes('pune')
      ) {
        subdomain = 'in';
      }

      // 4. Construct Search URL
      let searchUrl = '';
      if (isLoggedIn) {
        searchUrl = `https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(searchTerm)}&location=${encodeURIComponent(cleanLocation)}&start=${(pageNum - 1) * 25}`;
      } else {
        searchUrl = `https://${subdomain}.linkedin.com/jobs/search?keywords=${encodeURIComponent(searchTerm)}&location=${encodeURIComponent(cleanLocation)}&start=${(pageNum - 1) * 25}&position=1&pageNum=${pageNum - 1}`;
      }

      this.logger.log(`[LinkedIn Agent] Navigating to search URL: ${searchUrl}`);
      await page.goto(searchUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3000);

      // Check for security verification redirect
      if (page.url().includes('checkpoint') || page.url().includes('security')) {
        this.logger.warn('[LinkedIn Agent] Blocked by security check (CAPTCHA). Aborting browser scrape.');
        throw new Error('LinkedIn security check triggered.');
      }

      // 5. Scroll to lazy-load job cards
      await this.scrollJobList(page, isLoggedIn);

      // 6. Extract card elements
      const cards = isLoggedIn 
        ? await page.$$('li[data-occludable-job-id], .jobs-search-results__list-item') 
        : await page.$$('.jobs-search__results-list li, .base-search-card, .base-card');

      this.logger.log(`[LinkedIn Agent] Found ${cards.length} raw job elements.`);

      // 7. Parse the cards
      for (const card of cards.slice(0, 10)) { // Limit to top 10 for safety
        try {
          let title = '';
          let company = '';
          let loc = cleanLocation;
          let url = '';
          let description = '';

          if (isLoggedIn) {
            // Logged-in selectors
            const titleEl = await card.$('.job-card-list__title');
            const companyEl = await card.$('.job-card-container__company-link, .job-card-container__primary-description');
            const urlEl = await card.$('a.job-card-list__title');

            if (titleEl) title = (await titleEl.innerText()).trim();
            if (companyEl) company = (await companyEl.innerText()).trim().split('\n')[0].trim();
            if (urlEl) {
              const relativeUrl = await urlEl.getAttribute('href');
              url = relativeUrl ? `https://www.linkedin.com${relativeUrl.split('?')[0]}` : '';
            }
          } else {
            // Guest selectors
            const titleEl = await card.$('.base-search-card__title');
            const companyEl = await card.$('.base-search-card__subtitle');
            const locEl = await card.$('.job-search-card__location');
            const urlEl = await card.$('.base-card__full-link');

            if (titleEl) title = (await titleEl.innerText()).trim();
            if (companyEl) company = (await companyEl.innerText()).trim();
            if (locEl) loc = (await locEl.innerText()).trim();
            if (urlEl) {
              const fullUrl = await urlEl.getAttribute('href');
              url = fullUrl ? fullUrl.split('?')[0] : '';
            }
          }

          if (title && company) {
            description = `LinkedIn job listing for a ${title} position at ${company} in ${loc}.`;
            const jobId = generateJobId('linkedin', company, title, url || searchUrl);
            jobs.push({
              jobId,
              source: 'linkedin',
              title,
              company,
              location: loc,
              applyUrl: url || searchUrl,
              description: description,
            });
          }
        } catch (cardErr) {
          this.logger.warn(`[LinkedIn Agent] Failed to parse card: ${cardErr.message}`);
        }
      }

    } catch (e) {
      this.logger.error(`[LinkedIn Agent] Error: ${e.message}`, e.stack);
    } finally {
      if (browser) {
        await browser.close();
      }
    }

    // Return scraped jobs or empty list if none found
    if (jobs.length === 0) {
      this.logger.log('[LinkedIn Agent] No jobs scraped.');
      return [];
    }

    return jobs;
  }

  private async injectAnonymization(context: BrowserContext): Promise<void> {
    await context.addInitScript(() => {
      // Mock webdriver
      Object.defineProperty(navigator, 'webdriver', {
        get: () => undefined,
      });

      // Mock plugins list
      Object.defineProperty(navigator, 'plugins', {
        get: () => [
          { name: 'Chrome PDF Viewer' },
          { name: 'Chromium PDF Viewer' },
          { name: 'WebKit built-in PDF' },
        ],
      });

      // Mock languages
      Object.defineProperty(navigator, 'languages', {
        get: () => ['en-US', 'en'],
      });

      // Mock chrome property
      (window as any).chrome = {
        runtime: {},
        loadTimes: function() {},
        csi: function() {},
        app: {},
      };

      // Mock WebGL context to prevent fingerprinting
      const getContext = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function(type: any, ...args: any[]) {
        if (type === 'webgl' || type === 'webgl2') {
          return null; // Block WebGL scans
        }
        return getContext.apply(this, [type, ...args]);
      };

      // Mock canvas toDataURL to throw off canvas fingerprinting
      const toDataURL = HTMLCanvasElement.prototype.toDataURL;
      HTMLCanvasElement.prototype.toDataURL = function(...args: any[]) {
        return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
      };
    });
  }

  private async attemptLogin(page: Page, user: string, pass: string): Promise<boolean> {
    try {
      this.logger.log('[LinkedIn Agent] Navigating to login screen...');
      await page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1500);

      // Locate input boxes
      const usernameInput = await page.$('input#username');
      const passwordInput = await page.$('input#password');
      const submitBtn = await page.$('button[type=submit]');

      if (!usernameInput || !passwordInput || !submitBtn) {
        this.logger.warn('[LinkedIn Agent] Login form elements not found.');
        return false;
      }

      // Type username like a human
      await usernameInput.focus();
      for (const char of user) {
        await page.keyboard.press(char);
        await page.waitForTimeout(Math.random() * 100 + 40);
      }
      await page.waitForTimeout(500);

      // Type password like a human
      await passwordInput.focus();
      for (const char of pass) {
        await page.keyboard.press(char);
        await page.waitForTimeout(Math.random() * 100 + 40);
      }
      await page.waitForTimeout(800);

      // Click sign in
      await submitBtn.click();
      await page.waitForTimeout(4000);

      // Verify if login succeeded
      const currentUrl = page.url();
      if (currentUrl.includes('feed') || currentUrl.includes('jobs') || currentUrl.includes('search')) {
        this.logger.log('[LinkedIn Agent] Successfully authenticated!');
        return true;
      }

      this.logger.warn('[LinkedIn Agent] Authentication failed or check points required.');
      return false;
    } catch (e) {
      this.logger.error(`[LinkedIn Agent] Login attempt threw exception: ${e.message}`);
      return false;
    }
  }

  private async scrollJobList(page: Page, isLoggedIn: boolean): Promise<void> {
    try {
      // Find scrolling container
      const containerSelector = isLoggedIn 
        ? '.jobs-search-results-list, div[class*="jobs-search-results"]' 
        : 'window'; // For guest, we scroll the window

      this.logger.log(`[LinkedIn Agent] Scrolling container: ${containerSelector}`);

      if (isLoggedIn) {
        const container = await page.$(containerSelector);
        if (container) {
          for (let i = 0; i < 4; i++) {
            await container.evaluate((el) => el.scrollTop = el.scrollHeight * (i / 4));
            await page.waitForTimeout(1000);
          }
        }
      } else {
        for (let i = 0; i < 4; i++) {
          await page.evaluate((val) => window.scrollTo(0, document.body.scrollHeight * (val / 4)), i);
          await page.waitForTimeout(1000);
        }
        // Try guest "See more jobs" button
        const seeMore = await page.$('button.infinite-scroller__show-more-button');
        if (seeMore && await seeMore.isVisible()) {
          await seeMore.click();
          await page.waitForTimeout(1500);
        }
      }
    } catch (err) {
      this.logger.debug(`[LinkedIn Agent] Scroll failed: ${err.message}`);
    }
  }
}
