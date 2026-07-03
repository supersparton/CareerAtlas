import { Camoufox } from 'camoufox';
import { Page, Browser, BrowserContext } from 'playwright';
import { WatcherJobPayload, ScrapeResult, NormalizedJob, SearchTask } from '../types';
import * as crypto from 'crypto';

/**
 * Helper to simulate human typing delay
 */
async function typeHumanLike(page: Page, selector: string, text: string) {
  const element = page.locator(selector);
  await element.click();
  // Clear existing text by selecting all and pressing Backspace
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(200 + Math.random() * 200);

  // Type each character with a random delay (50ms - 150ms)
  for (const char of text) {
    await page.keyboard.type(char);
    await page.waitForTimeout(50 + Math.random() * 100);
  }
  await page.waitForTimeout(300 + Math.random() * 200);
}

/**
 * Detects if a page contains anti-bot challenges like Cloudflare or Access Denied
 */
async function checkAntiBot(page: Page): Promise<boolean> {
  const content = await page.content();
  const lowerContent = content.toLowerCase();
  
  const indicators = [
    'cloudflare',
    'security check',
    'verify you are human',
    'access denied',
    'ddg-captcha',
    'hcaptcha',
    'recaptcha',
    'blocked',
    'please enable javascript'
  ];

  for (const indicator of indicators) {
    if (lowerContent.includes(indicator) && page.url().includes('challenge')) {
      return true;
    }
  }

  // Check if page title contains suspicious blocking messages
  const title = (await page.title()).toLowerCase();
  if (title.includes('attention required') || title.includes('access denied') || title.includes('just a moment')) {
    return true;
  }

  return false;
}

/**
 * Automatically dismisses cookie consent, privacy notifications, or "Done" buttons
 */
async function handleCookieBanners(page: Page, log: (msg: string) => void) {
  const consentSelectors = [
    // OneTrust
    '#onetrust-accept-btn-handler',
    // Cookiebot
    '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
    // Common buttons with text
    'button:has-text("Accept All")',
    'button:has-text("Accept Cookies")',
    'button:has-text("Accept")',
    'button:has-text("Allow All")',
    'button:has-text("Allow")',
    'button:has-text("Done")',
    'button:has-text("Got it")',
    'button:has-text("Dismiss")',
    'button:has-text("I Agree")',
    'button:has-text("Agree")',
    '[role="button"]:has-text("Done")',
    '[role="button"]:has-text("Accept All")',
    '[role="button"]:has-text("Accept")',
    // Class/Id specific but generic
    '[class*="cookie" i] button:has-text("Accept")',
    '[id*="cookie" i] button:has-text("Accept")',
    '[class*="consent" i] button:has-text("Accept")',
    '[id*="consent" i] button:has-text("Accept")',
    'a:has-text("Accept All")',
    'a:has-text("Accept")'
  ];

  for (const selector of consentSelectors) {
    try {
      const element = page.locator(selector).first();
      if ((await element.count()) > 0 && (await element.isVisible())) {
        log(`Cookie consent / Done banner detected. Clicking button matching: "${selector}"...`);
        await element.click({ timeout: 1500 });
        // Wait a brief moment for the overlay/modal to disappear
        await page.waitForTimeout(1000);
      }
    } catch (_) {
      // Ignore failures or timeouts on individual selectors
    }
  }
}

/**
 * Automatically identifies input elements on the career page using common patterns
 */
async function findSearchInputs(page: Page): Promise<{
  roleSelector: string | null;
  locationSelector: string | null;
  submitSelector: string | null;
}> {
  // First, wait up to 5 seconds for at least one visible input to exist on the page (supports client-side dynamic hydration)
  try {
    await page.waitForSelector('input', { state: 'visible', timeout: 5000 });
  } catch (_) {
    // Continue even if timeout, the page might already be hydrated/static
  }

  // Broad selectors for Role / Keyword inputs
  const roleSelectors = [
    'input#search_typeahead-homepage', // Amazon Jobs specific
    'input[placeholder*="title" i]',
    'input[placeholder*="role" i]',
    'input[placeholder*="keyword" i]',
    'input[placeholder*="job" i]',
    'input[placeholder*="search" i]',
    'input[name*="keyword" i]',
    'input[name*="query" i]',
    'input[name*="title" i]',
    'input[aria-label*="keyword" i]',
    'input[aria-label*="search" i]',
    'input[id*="keyword" i]',
    'input[id*="search" i]',
    'input:not([type="hidden"]):not([type="submit"]):not([type="checkbox"]):not([type="radio"])' // General text input fallback
  ];

  // Broad selectors for Location inputs
  const locationSelectors = [
    'input#location-typeahead-homepage', // Amazon Jobs specific
    'input[placeholder*="location" i]',
    'input[placeholder*="city" i]',
    'input[placeholder*="country" i]',
    'input[placeholder*="state" i]',
    'input[name*="location" i]',
    'input[name*="city" i]',
    'input[aria-label*="location" i]',
    'input[id*="location" i]'
  ];

  // Broad selectors for search submit buttons
  const submitSelectors = [
    'button#search-button', // Amazon Jobs specific
    'button[type="submit"]',
    'input[type="submit"]',
    'button:has-text("Search")',
    'button:has-text("Find")',
    'button:has-text("Go")',
    'a:has-text("Search")',
    'span:has-text("Search")',
    '[class*="search-button" i]',
    '[class*="search-btn" i]',
    '[class*="submit" i]',
    'button:has(svg)',
    'button:has(i)'
  ];

  let roleSelector: string | null = null;
  const generalFallback = 'input:not([type="hidden"]):not([type="submit"]):not([type="checkbox"]):not([type="radio"])';
  
  for (const sel of roleSelectors) {
    try {
      const count = await page.locator(sel).count();
      if (count > 0 && await page.locator(sel).first().isVisible()) {
        roleSelector = sel;
        break;
      }
    } catch (_) {}
  }

  let locationSelector: string | null = null;
  for (const sel of locationSelectors) {
    try {
      const count = await page.locator(sel).count();
      if (count > 0 && await page.locator(sel).first().isVisible()) {
        // Ensure we don't pick the same input as the role selector
        if (sel === generalFallback && roleSelector === generalFallback) {
          continue;
        }
        locationSelector = sel;
        break;
      }
    } catch (_) {}
  }

  let submitSelector: string | null = null;
  for (const sel of submitSelectors) {
    try {
      const count = await page.locator(sel).count();
      if (count > 0 && await page.locator(sel).first().isVisible()) {
        submitSelector = sel;
        break;
      }
    } catch (_) {}
  }

  return { roleSelector, locationSelector, submitSelector };
}

/**
 * Verifies if a URL is likely a specific job posting, rather than a generic
 * marketing, team, category, location, or search results page.
 */
function isLikelyJobPostingUrl(url: string): boolean {
  const urlLower = url.toLowerCase();

  // Ignore blank, JavaScript triggers, or hashes
  if (!urlLower || urlLower.endsWith('#') || urlLower.includes('javascript:')) {
    return false;
  }

  // Common URL terms indicating informational or category index pages, not individual postings
  const invalidPathTerms = [
    '/job-categories',
    '/job-category',
    '/jobs-by-category',
    '/jobs-by-location',
    '/jobs-by-team',
    '/how-we-hire',
    '/job-application-tips',
    '/privacy',
    '/terms',
    '/cookies',
    '/about',
    '/teams',
    '/locations',
    '/career-path',
    '/students',
    '/faqs',
    '/faq',
    '/benefits',
    '/diversity',
    '/blog',
    '/content/',
    '/life-at',
    '/working-at',
    '/culture',
    '/careers/search',
    '/jobs/search',
    '/jobs-search',
    '/category/',
    '/location/',
    '/team/'
  ];

  for (const term of invalidPathTerms) {
    if (urlLower.includes(term)) {
      return false;
    }
  }

  return true;
}

/**
 * Automatically searches all visible links on a marketing page to identify
 * a direct link to an Applicant Tracking System (ATS) or search portal.
 */
async function findDirectSearchPortalLink(page: Page, currentUrl: string, log: (msg: string) => void): Promise<string | null> {
  let origin = '';
  try {
    origin = new URL(currentUrl).origin;
  } catch (_) {
    return null;
  }

  const links = await page.locator('a').all();

  const atsKeywords = [
    'workdayjobs.com',
    'greenhouse.io',
    'lever.co',
    'smartrecruiters.com',
    'ashbyhq.com',
    'bamboohr.com',
    'workable.com',
    'recruitee.com',
    'icims.com',
    'jobvite.com',
    'taleo.net',
    'brassring.com'
  ];

  const searchKeywords = [
    '/search',
    '/openings',
    '/positions',
    '/vacancies',
    '/all-jobs',
    '/jobs-list'
  ];

  const candidateUrls: string[] = [];

  for (const link of links) {
    try {
      if (!(await link.isVisible())) continue;
      let href = await link.getAttribute('href');
      if (!href) continue;

      // Handle relative links
      if (!href.startsWith('http') && !href.startsWith('//')) {
        href = new URL(href, origin).toString();
      } else if (href.startsWith('//')) {
        href = `https:${href}`;
      }

      const hrefLower = href.toLowerCase();

      // Skip current page redirects
      if (hrefLower === currentUrl.toLowerCase() || hrefLower === `${currentUrl.toLowerCase()}/`) {
        continue;
      }

      // Check if it's a known ATS
      const matchesAts = atsKeywords.some(keyword => hrefLower.includes(keyword));
      if (matchesAts) {
        log(`Found direct ATS link: "${href}".`);
        return href; // Highly reliable, return immediately
      }

      // Check if it matches search path keywords and is not a content/marketing page
      const matchesSearch = searchKeywords.some(keyword => hrefLower.includes(keyword));
      if (matchesSearch && isLikelyJobPostingUrl(href)) {
        candidateUrls.push(href);
      }
    } catch (_) {}
  }

  if (candidateUrls.length > 0) {
    log(`Found candidate search portal link: "${candidateUrls[0]}".`);
    return candidateUrls[0];
  }

  return null;
}

/**
 * Extracts job listing details from the page after search execution
 */
async function extractJobs(page: Page, companyName: string, careerUrl: string): Promise<NormalizedJob[]> {
  const jobs: NormalizedJob[] = [];
  const origin = new URL(page.url()).origin;

  // Let's identify job card/item containers
  const containers = await page.locator(
    '[class*="job-list" i] > *,' +
    '[class*="job-item" i],' +
    '[class*="job-card" i],' +
    '[class*="job-tile" i],' +
    '[class*="posting" i],' +
    'article,' +
    'tr:has(a[href*="/job" i])'
  ).all();

  if (containers.length > 0) {
    for (const container of containers) {
      try {
        if (!(await container.isVisible())) continue;

        // Find the title element and link inside container
        const linkElement = container.locator('a[href*="/job" i], a[href*="/posting" i]').first();
        const linkCount = await linkElement.count();
        if (linkCount === 0) continue;

        const titleText = await linkElement.innerText();
        let jobUrl = (await linkElement.getAttribute('href')) || '';
        if (jobUrl && !jobUrl.startsWith('http')) {
          jobUrl = new URL(jobUrl, origin).toString();
        }

        if (!titleText || !jobUrl || !isLikelyJobPostingUrl(jobUrl)) continue;

        // Try extracting location
        let location = 'Unknown';
        const locSelectors = [
          '[class*="location" i]',
          '[class*="meta" i]',
          'span:nth-child(2)',
          'td:nth-child(2)'
        ];
        for (const locSel of locSelectors) {
          try {
            const locEl = container.locator(locSel).first();
            if (await locEl.count() > 0) {
              const text = await locEl.innerText();
              if (text && text.trim().length > 2) {
                location = text.trim();
                break;
              }
            }
          } catch (_) {}
        }

        // Try extracting remote status & employment type
        let remoteStatus = 'On-site';
        let employmentType = 'Full-time';
        const rawText = (await container.innerText()).toLowerCase();
        if (rawText.includes('remote') || rawText.includes('work from home') || rawText.includes('wfh')) {
          remoteStatus = 'Remote';
        } else if (rawText.includes('hybrid')) {
          remoteStatus = 'Hybrid';
        }

        if (rawText.includes('part-time') || rawText.includes('part time')) {
          employmentType = 'Part-time';
        } else if (rawText.includes('contract') || rawText.includes('temporary')) {
          employmentType = 'Contract';
        } else if (rawText.includes('intern') || rawText.includes('co-op')) {
          employmentType = 'Intern';
        }

        const jobId = crypto.createHash('md5').update(`${companyName}-${jobUrl}`).digest('hex');

        jobs.push({
          jobId,
          company: companyName,
          title: titleText.replace(/\s+/g, ' ').trim(),
          location: location.replace(/\s+/g, ' ').trim(),
          employmentType,
          remoteStatus,
          jobUrl,
          source: 'company_career_page',
        });
      } catch (e) {
        // Skip individual card failures
      }
    }
  }

  // Fallback: If no structured cards are identified, extract any links pointing to jobs
  if (jobs.length === 0) {
    const links = await page.locator('a[href*="/job" i], a[href*="/posting" i]').all();
    for (const link of links) {
      try {
        if (!(await link.isVisible())) continue;
        const text = await link.innerText();
        let href = (await link.getAttribute('href')) || '';
        if (href && !href.startsWith('http')) {
          href = new URL(href, origin).toString();
        }

        if (text && text.trim().length > 5 && href && isLikelyJobPostingUrl(href)) {
          const title = text.replace(/\s+/g, ' ').trim();
          // Filter out generic navigation links
          if (/login|apply|career|jobs|search|back|next/i.test(title)) continue;

          const jobId = crypto.createHash('md5').update(`${companyName}-${href}`).digest('hex');
          jobs.push({
            jobId,
            company: companyName,
            title,
            location: 'Multiple Locations / Check Posting',
            jobUrl: href,
            source: 'company_career_page',
          });
        }
      } catch (_) {}
    }
  }

  return jobs;
}

/**
 * Orchestrates a batch of searches on a company's career page
 */
export async function executeCompanyScrapeBatch(
  payload: WatcherJobPayload,
  onProgress?: (log: string) => void
): Promise<ScrapeResult[]> {
  const results: ScrapeResult[] = [];
  const log = (msg: string) => {
    if (onProgress) onProgress(msg);
    console.log(`[SCRAPER] [${payload.company}] ${msg}`);
  };

  log(`Launching anti-detect browser for ${payload.company}...`);

  let browser: any = null;
  let context: any = null;
  let page: any = null;

  try {
    // Launch Camoufox anti-detect browser
    browser = await Camoufox({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    context = await browser.newContext({
      viewport: null,
      locale: 'en-US',
      timezoneId: 'America/New_York',
    });

    page = await context.newPage();

    log(`Navigating to official career URL: ${payload.careerUrl}`);
    await page.goto(payload.careerUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    
    // Wait for page to dynamic load/hydrate
    await page.waitForTimeout(2000);

    // Check anti-bot challenges
    if (await checkAntiBot(page)) {
      log('WARNING: Anti-bot page/CAPTCHA detected immediately upon landing!');
      throw new Error('Anti-bot page/CAPTCHA detected on landing');
    }

    // Dismiss cookie consent banners or privacy done overlays
    await handleCookieBanners(page, log);

    // Attempt to locate inputs automatically
    log('Locating search inputs and buttons...');
    let selectors = await findSearchInputs(page);
    log(`Located inputs: Role[${selectors.roleSelector || 'Not Found'}], Location[${selectors.locationSelector || 'Not Found'}], SearchButton[${selectors.submitSelector || 'Not Found'}]`);

    // Self-healing: If we land on a marketing page with no search input, look for transition links
    if (!selectors.roleSelector) {
      log('Could not find search inputs on landing page. Checking for direct search portal URL in links...');
      const portalUrl = await findDirectSearchPortalLink(page, page.url(), log);
      
      let navigated = false;
      if (portalUrl) {
        log(`Navigating directly to discovered job portal: "${portalUrl}"...`);
        try {
          await page.goto(portalUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
          await page.waitForTimeout(2000);
          navigated = true;
        } catch (err: any) {
          log(`Failed to navigate to direct job portal URL: ${err.message}. Falling back to click transitions.`);
        }
      }

      if (!navigated) {
        log('No direct ATS link matched. Checking for transition buttons to click...');
        const transitionTexts = [
          'Find Your Next Job',
          'Open Positions',
          'Search Jobs',
          'View Openings',
          'See Openings',
          'Search Roles',
          'View Jobs',
          'Explore Jobs',
          'Job Search',
          'Job Openings'
        ];

        for (const text of transitionTexts) {
          try {
            const locator = page.locator(
              `a:has-text("${text}"):visible, ` +
              `button:has-text("${text}"):visible, ` +
              `[role="button"]:has-text("${text}"):visible, ` +
              `div:has-text("${text}"):not(:has(*)):visible, ` +
              `span:has-text("${text}"):not(:has(*)):visible`
            ).first();

            if ((await locator.count()) > 0) {
              log(`Found transition button/link: "${text}". Clicking it to navigate to the actual job board...`);
              
              // Set up popup listener in case it opens in a new tab
              const popupPromise = page.context().waitForEvent('page', { timeout: 4000 }).catch(() => null);
              await locator.click();
              
              const popup = await popupPromise;
              if (popup) {
                log('Redirected to a new tab. Switching scraper context to the new tab...');
                page = popup;
                await page.waitForLoadState('domcontentloaded').catch(() => {});
              } else {
                await page.waitForTimeout(3000);
              }
              
              navigated = true;
              break;
            }
          } catch (err: any) {
            log(`Error clicking transition link for "${text}": ${err.message}`);
          }
        }
      }

      if (navigated) {
        // Dismiss cookie banners again on the new page
        await handleCookieBanners(page, log);
        
        // Re-detect inputs on the new page
        log('Re-locating search inputs and buttons on the new page...');
        selectors = await findSearchInputs(page);
        log(`Located inputs on new page: Role[${selectors.roleSelector || 'Not Found'}], Location[${selectors.locationSelector || 'Not Found'}], SearchButton[${selectors.submitSelector || 'Not Found'}]`);
      }
    }

    // Greenhouse and Lever fallback: If these boards are embedded directly, they list all jobs.
    // We don't need inputs or clicks; we can just extract jobs from the page and filter them locally.
    const isJobBoardAggregator = payload.careerUrl.includes('greenhouse.io') || payload.careerUrl.includes('lever.co');

    for (const search of payload.searches) {
      log(`Executing search: "${search.role}" in "${search.location}"`);

      try {
        let matchingJobs: NormalizedJob[] = [];

        if (isJobBoardAggregator) {
          // Greenhouse/Lever in-memory filter
          log('Job board aggregator detected (Greenhouse/Lever). Running in-memory extraction...');
          const allJobs = await extractJobs(page, payload.company, payload.careerUrl);
          log(`Extracted total ${allJobs.length} jobs from aggregator page.`);
          
          const roleLower = search.role.toLowerCase();
          const locLower = search.location.toLowerCase();
          matchingJobs = allJobs.filter(job => {
            const mTitle = job.title.toLowerCase().includes(roleLower);
            const mLoc = job.location.toLowerCase().includes(locLower) || locLower === 'any' || locLower === 'remote';
            return mTitle && mLoc;
          });
        } else {
          // Standard interactive search flow
          if (!selectors.roleSelector) {
            throw new Error('Could not identify role search input on page');
          }

          // Type Role
          await typeHumanLike(page, selectors.roleSelector, search.role);

          // Type Location (if input is found)
          if (selectors.locationSelector) {
            await typeHumanLike(page, selectors.locationSelector, search.location);
            // Wait up to 1.5 seconds for autocomplete typeahead suggestions to render
            await page.waitForTimeout(1500);

            // Handle typeahead autocomplete selection
            let suggestionClicked = false;
            const suggestionSelectors = [
              '.tt-suggestion',
              '[class*="suggestion" i]',
              '[class*="selectable" i]',
              '[class*="typeahead" i] li',
              '[role="option"]',
              'ul[role="listbox"] li'
            ];
            for (const sugSel of suggestionSelectors) {
              try {
                const suggestion = page.locator(sugSel).first();
                if ((await suggestion.count()) > 0 && (await suggestion.isVisible())) {
                  log(`Clicking autocomplete suggestion matching: "${sugSel}"`);
                  await suggestion.click({ timeout: 1500 });
                  suggestionClicked = true;
                  break;
                }
              } catch (_) {}
            }

            if (!suggestionClicked) {
              log('No clickable suggestion found. Simulating ArrowDown + Enter for autocomplete selection...');
              try {
                await page.keyboard.press('ArrowDown');
                await page.waitForTimeout(300);
                await page.keyboard.press('Enter');
                await page.waitForTimeout(500);
              } catch (_) {}
            }
          }

          // Click search button
          if (selectors.submitSelector) {
            log('Clicking search button...');
            await page.click(selectors.submitSelector);
          } else {
            log('No search button found. Submitting via Enter key...');
            await page.keyboard.press('Enter');
          }

          // Wait for results
          await page.waitForTimeout(2500);
          await page.waitForLoadState('networkidle').catch(() => {});

          // Extract
          matchingJobs = await extractJobs(page, payload.company, payload.careerUrl);
        }

        log(`Found ${matchingJobs.length} matching jobs for "${search.role}"`);

        results.push({
          searchId: search.searchId,
          jobs: matchingJobs,
          success: true,
          searchPageUrl: page.url(),
        });

      } catch (err: any) {
        log(`Error executing search: ${err.message}`);
        results.push({
          searchId: search.searchId,
          jobs: [],
          success: false,
          error: err.message,
        });

        // Take a screenshot of the failure state
        try {
          const timestamp = Date.now();
          const screenshotPath = `screenshot_${payload.company}_${search.searchId}_${timestamp}.png`;
          await page.screenshot({ path: screenshotPath });
          log(`Saved failure screenshot to: ${screenshotPath}`);
        } catch (_) {}
      }
    }

  } catch (err: any) {
    log(`Fatal batch failure: ${err.message}`);
    // Return failures for all pending searches
    for (const search of payload.searches) {
      if (!results.find(r => r.searchId === search.searchId)) {
        results.push({
          searchId: search.searchId,
          jobs: [],
          success: false,
          error: `Fatal batch error: ${err.message}`,
        });
      }
    }
  } finally {
    if (page) await page.close().catch(() => {});
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    log('Anti-detect browser session closed.');
  }

  return results;
}
