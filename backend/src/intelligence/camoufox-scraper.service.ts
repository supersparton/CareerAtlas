import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Camoufox } from 'camoufox';

export interface ScrapedJobDetails {
  description: string | null;
  title: string | null;
  company: string | null;
}

@Injectable()
export class CamoufoxScraperService implements OnModuleDestroy {
  private readonly logger = new Logger(CamoufoxScraperService.name);
  private browser: any = null;
  private browserInitPromise: Promise<any> | null = null;

  async onModuleDestroy() {
    if (this.browser) {
      this.logger.log('[CAMOUFOX] Closing shared browser session...');
      try {
        await this.browser.close();
      } catch (err: any) {
        this.logger.error(`[CAMOUFOX] Error closing browser: ${err.message}`);
      }
      this.browser = null;
    }
  }

  private async getBrowser(): Promise<any> {
    if (this.browser && typeof this.browser.isConnected === 'function' && this.browser.isConnected()) {
      return this.browser;
    }
    // Prevent race condition: reuse in-flight initialization
    if (this.browserInitPromise) {
      return this.browserInitPromise;
    }
    this.browserInitPromise = (async () => {
      this.logger.log('[CAMOUFOX] Launching shared anti-detect browser instance...');
      const isProduction = process.env.NODE_ENV === 'production';
      this.browser = await Camoufox({
        headless: true,
        args: isProduction ? [] : ['--no-sandbox', '--disable-setuid-sandbox'],
      });
      return this.browser;
    })();
    try {
      return await this.browserInitPromise;
    } finally {
      this.browserInitPromise = null;
    }
  }

  async scrapeUrl(url: string): Promise<ScrapedJobDetails | null> {
    const camoufoxStart = Date.now();
    this.logger.log(`[CAMOUFOX] Scraping URL using shared browser: ${url}`);
    let context: any = null;
    let page: any = null;
    try {
      const browserInstance = await this.getBrowser();
      context = await browserInstance.newContext({ viewport: null });
      context.on('pageerror', () => {});
      page = await context.newPage();
      page.on('pageerror', () => {});
      
      // Block heavy static assets (images, fonts, media, stylesheets) to speed up page load 15x and save RAM
      await page.route('**/*', (route: any) => {
        const req = route.request();
        const resourceType = req.resourceType();
        if (['image', 'media', 'font', 'stylesheet'].includes(resourceType)) {
          return route.abort();
        }
        return route.continue();
      });

      // Navigate with a 10-second timeout
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 10000 });

      // Wait a moment for dynamic SPAs to hydrate
      await page.waitForTimeout(1750);

      // Check for authwall redirects or login checks
      const finalUrl = page.url().toLowerCase();
      if (finalUrl.includes('linkedin.com/authwall') || finalUrl.includes('login') || finalUrl.includes('checkpoint')) {
        const durationMs = Date.now() - camoufoxStart;
        this.logger.warn(`[LATENCY-WARN] [camoufox] Redirected/blocked after ${durationMs}ms: ${finalUrl}`);
        return null;
      }

      // Try to extract title and company from JSON-LD or meta tags
      let extractedTitle: string | null = null;
      let extractedCompany: string | null = null;

      // 1. Try to extract from application/ld+json script tags first (highly robust for job postings)
      let jsonLdDesc = '';
      try {
        const jsonLdScripts = await page.$$('script[type="application/ld+json"]');
        for (const script of jsonLdScripts) {
          const content = await script.innerText().catch(() => '');
          if (content && content.includes('"description"')) {
            const data = JSON.parse(content.trim());
            // Schema.org JobPosting format
            if (data.description || (data['@type'] === 'JobPosting' && data.description)) {
              const rawHtml = data.description || '';
              // Remove HTML tags since we want plain text description
              jsonLdDesc = rawHtml.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
              if (data.title) {
                extractedTitle = data.title;
              }
              if (data.hiringOrganization) {
                if (typeof data.hiringOrganization === 'string') {
                  extractedCompany = data.hiringOrganization;
                } else if (data.hiringOrganization.name) {
                  extractedCompany = data.hiringOrganization.name;
                } else if (data.hiringOrganization.legalName) {
                  extractedCompany = data.hiringOrganization.legalName;
                }
              }
              if (jsonLdDesc.length > 200) {
                this.logger.log(`[CAMOUFOX] Successfully extracted ${jsonLdDesc.length} characters from JSON-LD schema.`);
                break;
              }
            }
          }
        }
      } catch (jsonLdErr) {
        this.logger.warn(`[CAMOUFOX] Failed to parse JSON-LD schema: ${jsonLdErr.message}`);
      }

      // If missing, fall back to meta/title tags
      if (!extractedTitle) {
        extractedTitle = await page.title().catch(() => '');
      }

      try {
        const ogTitle = await page.$eval('meta[property="og:title"]', el => el.content).catch(() => '');
        const ogSiteName = await page.$eval('meta[property="og:site_name"]', el => el.content).catch(() => '');
        
        if (!extractedTitle && ogTitle) {
          extractedTitle = ogTitle;
        }
        if (!extractedCompany && ogSiteName) {
          extractedCompany = ogSiteName;
        }
      } catch (metaErr) {
        // ignore
      }

      if (jsonLdDesc && jsonLdDesc.length > 200) {
        const durationMs = Date.now() - camoufoxStart;
        this.logger.log(`[LATENCY] [camoufox] Successfully scraped ${jsonLdDesc.length} chars via JSON-LD in ${durationMs}ms for URL: ${url}`);
        return {
          description: jsonLdDesc,
          title: extractedTitle ? String(extractedTitle).trim() : null,
          company: extractedCompany ? String(extractedCompany).trim() : null,
        };
      }

      // Handle common job platforms specific behaviors (like clicking "Show More" buttons)
      const urlLower = url.toLowerCase();
      if (urlLower.includes('linkedin.com')) {
        try {
          const showMoreBtn = await page.$('button.show-more-less-html__button--more');
          if (showMoreBtn) {
            this.logger.log('[CAMOUFOX] Found LinkedIn "Show More" button. Clicking to expand...');
            await showMoreBtn.click();
            await page.waitForTimeout(1000);
          }
        } catch (e) {
          this.logger.warn(`[CAMOUFOX] Failed to click LinkedIn show more button: ${e.message}`);
        }
      }

      // Extract raw body text or target specific job containers
      let scrapedText = '';
      if (urlLower.includes('lever.co')) {
        scrapedText = await page.locator('.section-wrapper, .sectionpage').first().innerText().catch(() => '');
      } else if (urlLower.includes('greenhouse.io')) {
        scrapedText = await page.locator('#content').first().innerText().catch(() => '');
      } else if (urlLower.includes('ashbyhq.com')) {
        scrapedText = await page.locator('[class*="_description_"]').first().innerText().catch(() => '');
      } else if (urlLower.includes('linkedin.com')) {
        scrapedText = await page.locator('.show-more-less-html__markup, .description__text').first().innerText().catch(() => '');
      }

      if (!scrapedText) {
        // Fallback: extract main body text
        scrapedText = await page.locator('body').innerText().catch(() => '');
      }

      // Basic cleanup
      scrapedText = scrapedText.replace(/\s+/g, ' ').trim();

      const durationMs = Date.now() - camoufoxStart;
      if (scrapedText.length > 200) {
        this.logger.log(`[LATENCY] [camoufox] Successfully scraped ${scrapedText.length} chars in ${durationMs}ms for URL: ${url}`);
        return {
          description: scrapedText,
          title: extractedTitle ? String(extractedTitle).trim() : null,
          company: extractedCompany ? String(extractedCompany).trim() : null,
        };
      }
      this.logger.warn(`[LATENCY-WARN] [camoufox] Scrape finished in ${durationMs}ms but text was insufficient (<200 chars) for URL: ${url}`);
      return null;
    } catch (err) {
      const durationMs = Date.now() - camoufoxStart;
      this.logger.error(`[LATENCY-ERROR] [camoufox] Failed to scrape URL after ${durationMs}ms (${url}): ${err.message}`);
      return null;
    } finally {
      if (page) {
        try {
          await page.close();
        } catch (pageCloseErr: any) {
          this.logger.warn(`[CAMOUFOX] Error closing page: ${pageCloseErr.message}`);
        }
      }
      if (context) {
        try {
          await context.close();
        } catch (contextCloseErr: any) {
          this.logger.warn(`[CAMOUFOX] Error closing context: ${contextCloseErr.message}`);
        }
      }
    }
  }
}
