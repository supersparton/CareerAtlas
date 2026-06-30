import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class CompanyResolverService {
  private readonly logger = new Logger(CompanyResolverService.name);

  /**
   * Tries to resolve the career URL to an ATS provider and slug.
   */
  async resolveCompany(
    companyName: string,
    url: string
  ): Promise<{ providerType: string; providerSlug: string; domain: string }> {
    this.logger.log(`Resolving company ${companyName} with URL: ${url}`);
    
    let currentUrl = url.trim();
    if (!/^https?:\/\//i.test(currentUrl)) {
      currentUrl = `https://${currentUrl}`;
    }

    try {
      const parsedUrl = new URL(currentUrl);
      const domain = parsedUrl.hostname.toLowerCase();

      // Tier 1: Direct Domain Check
      const directMatch = this.detectAtsFromUrl(parsedUrl);
      if (directMatch) {
        this.logger.log(`[Tier 1 Direct Match] Found ATS: ${directMatch.providerType} (${directMatch.providerSlug})`);
        return { ...directMatch, domain };
      }

      // Tier 2 & 3: Follow redirects and inspect page content/links
      this.logger.log(`[Tier 2 Sniffing] Crawling landing page to follow redirects/sniff ATS...`);
      const sniffResult = await this.sniffPageContent(currentUrl);
      if (sniffResult) {
        this.logger.log(`[Tier 2 Sniff Match] Found ATS: ${sniffResult.providerType} (${sniffResult.providerSlug})`);
        return { ...sniffResult, domain };
      }

      // Return unknown if no match
      return {
        providerType: 'unknown',
        providerSlug: '',
        domain,
      };
    } catch (err) {
      this.logger.error(`Error resolving company URL ${url}: ${err.message}`);
      return {
        providerType: 'unknown',
        providerSlug: '',
        domain: url,
      };
    }
  }

  /**
   * Helper to detect ATS directly from the URL structure
   */
  private detectAtsFromUrl(parsedUrl: URL): { providerType: string; providerSlug: string } | null {
    const host = parsedUrl.hostname.toLowerCase();
    const pathname = parsedUrl.pathname;

    // 1. Greenhouse
    if (host.includes('greenhouse.io')) {
      // e.g. https://boards.greenhouse.io/databricks
      const parts = pathname.split('/').filter(Boolean);
      const slug = parts[0] || '';
      return { providerType: 'greenhouse', providerSlug: slug };
    }

    // 2. Lever
    if (host.includes('lever.co')) {
      // e.g. https://jobs.lever.co/databricks
      const parts = pathname.split('/').filter(Boolean);
      const slug = parts[0] || '';
      return { providerType: 'lever', providerSlug: slug };
    }

    // 3. Ashby
    if (host.includes('ashbyhq.com')) {
      // e.g. https://jobs.ashbyhq.com/company
      const parts = pathname.split('/').filter(Boolean);
      const slug = parts[0] || '';
      return { providerType: 'ashby', providerSlug: slug };
    }

    // 4. Workday
    if (host.includes('myworkdayjobs.com')) {
      // e.g. https://cisco.myworkdayjobs.com/Cisco_Careers
      const subdomain = host.split('.')[0];
      return { providerType: 'workday', providerSlug: subdomain };
    }

    return null;
  }

  /**
   * Follows redirects and downloads the landing page to search for links or embeds containing ATS keywords
   */
  private async sniffPageContent(url: string): Promise<{ providerType: string; providerSlug: string } | null> {
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9',
        },
        redirect: 'follow',
      });

      if (!response.ok) return null;

      // Check if redirect URL points to a standard ATS
      const redirectUrl = response.url;
      if (redirectUrl !== url) {
        const redirectParsed = new URL(redirectUrl);
        const directMatch = this.detectAtsFromUrl(redirectParsed);
        if (directMatch) return directMatch;
      }

      const html = await response.text();

      // Extract all URLs from href and src attributes to look for true integrations/links
      const urls: string[] = [];
      const urlRegex = /(?:href|src)=["'](https?:\/\/[^"']+)["']/gi;
      let match;
      while ((match = urlRegex.exec(html)) !== null) {
        urls.push(match[1]);
      }

      for (const urlStr of urls) {
        try {
          const parsed = new URL(urlStr);
          const atsMatch = this.detectAtsFromUrl(parsed);
          if (atsMatch && atsMatch.providerSlug) {
            const slugLower = atsMatch.providerSlug.toLowerCase();
            // Ignore generic keywords that might appear as slugs in script sources
            if (!['embed', 'js', 'api', 'v1', 'assets', 'static'].includes(slugLower)) {
              return atsMatch;
            }
          }
        } catch {}
      }

      return null;
    } catch (e) {
      this.logger.warn(`Failed to sniff page content for ${url}: ${e.message}`);
      return null;
    }
  }
}
