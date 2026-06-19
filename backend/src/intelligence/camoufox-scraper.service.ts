import { Injectable, Logger } from '@nestjs/common';
import { Camoufox } from 'camoufox';

@Injectable()
export class CamoufoxScraperService {
  private readonly logger = new Logger(CamoufoxScraperService.name);

  async scrapeUrl(url: string): Promise<string | null> {
    this.logger.log(`[CAMOUFOX] Launching anti-detect browser to scrape URL: ${url}`);
    let browser: any = null;
    try {
      browser = await Camoufox({
        headless: true,
      });

      const page = await browser.newPage();
      
      // Navigate with a 20-second timeout
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });

      // Wait a moment for dynamic SPAs to hydrate
      await page.waitForTimeout(2000);

      // Check for authwall redirects or login checks
      const finalUrl = page.url().toLowerCase();
      if (finalUrl.includes('linkedin.com/authwall') || finalUrl.includes('login') || finalUrl.includes('checkpoint')) {
        this.logger.warn(`[CAMOUFOX] Blocked/Redirected to login/authwall page: ${finalUrl}`);
        return null;
      }

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

      if (jsonLdDesc && jsonLdDesc.length > 200) {
        return jsonLdDesc;
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

      if (scrapedText.length > 200) {
        this.logger.log(`[CAMOUFOX] Successfully scraped ${scrapedText.length} characters.`);
        return scrapedText;
      }
      return null;
    } catch (err) {
      this.logger.error(`[CAMOUFOX] Failed to scrape URL ${url}: ${err.message}`);
      return null;
    } finally {
      if (browser) {
        try {
          await browser.close();
        } catch (closeErr) {
          this.logger.error(`[CAMOUFOX] Error closing browser: ${closeErr.message}`);
        }
      }
    }
  }
}
