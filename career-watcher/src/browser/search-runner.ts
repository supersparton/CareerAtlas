import { Camoufox } from 'camoufox';
import { Page, Browser, BrowserContext } from 'playwright';
import { WatcherJobPayload, ScrapeResult, NormalizedJob, SearchTask } from '../types';
import * as crypto from 'crypto';

/**
 * Helper to simulate human typing delay
 */
async function typeHumanLike(page: Page, selector: string, text: string) {
  const element = page.locator(selector).first();
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
    'button:has-text("Search"):not([aria-haspopup="true"]):not(:has-text("Save")):not(:has-text("Saved")):not(:has-text("Filter")):not(footer button):not([class*="footer" i] button):not([class*="directory" i] button):not([class*="nav" i] button)',
    'button:has-text("Find"):not([aria-haspopup="true"]):not(footer button):not([class*="footer" i] button):not([class*="directory" i] button):not([class*="nav" i] button)',
    'button:text-is("Go"):not([aria-haspopup="true"]):not(footer button):not([class*="footer" i] button):not([class*="directory" i] button):not([class*="nav" i] button)',
    '[class*="search-button" i]:not([aria-haspopup="true"]):not([class*="save" i]):not([class*="create" i]):not([class*="filter" i]):not(footer *):not([class*="footer" i] *):not([class*="directory" i] *):not([class*="nav" i] *)',
    '[class*="search-btn" i]:not([aria-haspopup="true"]):not([class*="save" i]):not([class*="create" i]):not([class*="filter" i]):not(footer *):not([class*="footer" i] *):not([class*="directory" i] *):not([class*="nav" i] *)',
    '[class*="submit" i]:not([class*="save" i]):not([class*="create" i]):not([class*="filter" i]):not(footer *):not([class*="footer" i] *):not([class*="directory" i] *):not([class*="nav" i] *)'
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
function isLikelyJobPostingUrl(url: string, originUrl: string): boolean {
  let urlObj: URL;
  let originObj: URL;
  try {
    urlObj = new URL(url);
    originObj = new URL(originUrl);
  } catch (_) {
    return false;
  }

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
    '/team/',
    '/sitemap',
    '/contact',
    '/help',
    '/retail',
    '/login',
    '/signin',
    '/sign-in',
    '/profile',
    '/account',
    '/register',
    '/signup',
    '/sign-up',
    '/choose-country',
    '/choose-region',
    '/select-country',
    '/select-region',
    '/language-select',
    '/session'
  ];

  for (const term of invalidPathTerms) {
    if (urlLower.includes(term)) {
      return false;
    }
  }

  // If the host is different from the origin host, check if it's a known ATS or if it contains careers/jobs
  if (urlObj.hostname !== originObj.hostname) {
    const knownAtsKeywords = ['workday', 'greenhouse', 'lever', 'recruiter', 'icims', 'taleo', 'brassring', 'bamboohr', 'jobvite', 'ultipro', 'successfactors'];
    const hasAtsKeyword = knownAtsKeywords.some(keyword => urlObj.hostname.includes(keyword));
    const hasCareerKeyword = urlObj.hostname.includes('jobs') || urlObj.hostname.includes('careers') || urlObj.pathname.includes('jobs') || urlObj.pathname.includes('careers');
    
    if (!hasAtsKeyword && !hasCareerKeyword) {
      return false;
    }
  }

  return true;
}

/**
 * Extracts job listing details from the page after search execution
 */
async function extractJobs(page: Page, companyName: string, careerUrl: string): Promise<NormalizedJob[]> {
  const jobs: NormalizedJob[] = [];
  const origin = new URL(page.url()).origin;

  const linkSelector = 'a[href*="/job" i], a[href*="/posting" i], a[href*="/details/" i], ' +
                       'a[href*="/detail/" i], a[href*="/vacancy/" i], a[href*="/position/" i], ' +
                       'a[href*="/requisition/" i], a[href*="/opening" i], a[href*="/apply/" i], ' +
                       'a[href*="?id=" i], a[href*="&id=" i], a[href*="/careers?" i], ' +
                       'a[href*="/career?" i], a[href*="/jobs/results/" i], a[href*="/jobs/view/" i]';

  // Let's identify job card/item containers
  const containers = await page.locator(
    '[class*="job-list" i] > *,' +
    '[class*="job-item" i],' +
    '[class*="job-card" i],' +
    '[class*="job-tile" i],' +
    '[class*="posting" i],' +
    'article,' +
    `tr:has(${linkSelector})`
  ).all();

  if (containers.length > 0) {
    for (const container of containers) {
      try {
        if (!(await container.isVisible())) continue;

        // Find the title element and link inside container
        const linkElement = container.locator(linkSelector).first();
        const linkCount = await linkElement.count();
        if (linkCount === 0) continue;

        const titleText = await linkElement.innerText();
        let jobUrl = (await linkElement.getAttribute('href')) || '';
        if (jobUrl && !jobUrl.startsWith('http')) {
          jobUrl = new URL(jobUrl, origin).toString();
        }

        if (!titleText || !jobUrl || !isLikelyJobPostingUrl(jobUrl, careerUrl)) continue;

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

  // Fallback 1: If no structured cards are identified, extract any links matching our job detail patterns
  if (jobs.length === 0) {
    const links = await page.locator(linkSelector).all();
    for (const link of links) {
      try {
        if (!(await link.isVisible())) continue;
        const text = await link.innerText();
        let href = (await link.getAttribute('href')) || '';
        if (href && !href.startsWith('http')) {
          href = new URL(href, origin).toString();
        }

        if (text && text.trim().length > 5 && href && isLikelyJobPostingUrl(href, careerUrl)) {
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

  // Fallback 2: General anchor tag heuristic if specific patterns still yield 0 jobs
  if (jobs.length === 0) {
    const allLinks = await page.locator('a[href]').all();
    for (const link of allLinks) {
      try {
        if (!(await link.isVisible())) continue;
        const text = (await link.innerText()).trim();
        let href = (await link.getAttribute('href')) || '';
        
        if (text.length > 5 && text.length < 100 && href) {
          if (!href.startsWith('http')) {
            href = new URL(href, origin).toString();
          }
          if (isLikelyJobPostingUrl(href, careerUrl)) {
            // Require fallback 2 links to match some minimal job path pattern or domain keyword to avoid generic corporate pages
            const isJobPattern = /\/(job|posting|vacancy|position|requisition|opening|apply|detail|details|careers?\/results)\//i.test(href) || 
                                 /(\?|&)(id|jobId|reqId|requisitionId)=/i.test(href) ||
                                 /jobs|careers/i.test(new URL(href).hostname);
            if (!isJobPattern) continue;

            const title = text.replace(/\s+/g, ' ').trim();
            // Filter out common UI control words
            if (/login|apply now|careers|jobs|search|back|next|view all|contact|privacy|terms|cookie|about/i.test(title)) continue;
            
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
        }
      } catch (_) {}
    }
  }

  return jobs;
}

interface InteractiveElement {
  selector: string;
  tagName: string;
  type?: string;
  placeholder?: string;
  role?: string;
  text?: string;
  value?: string;
  isVisible: boolean;
  ariaExpanded?: string;
  ariaHasPopup?: string;
  ariaLabel?: string;
}

interface AgentAction {
  evaluation_previous_goal: string;
  memory: string;
  next_goal: string;
  action: {
    type: 'type' | 'click' | 'press' | 'wait' | 'navigate' | 'scroll' | 'done';
    selector?: string;
    text?: string;
    key?: string;
    url?: string;
    direction?: 'down' | 'up';
  };
}

/**
 * Defensive JSON extraction helper that isolates and parses the first JSON block.
 */
function parseLLMResponse(text: string): any {
  let clean = text.trim();
  
  if (clean.startsWith('```')) {
    clean = clean.replace(/^```json\s*/i, '').replace(/```$/, '').trim();
  }
  
  const firstBrace = clean.indexOf('{');
  const lastBrace = clean.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    clean = clean.substring(firstBrace, lastBrace + 1);
  }
  
  return JSON.parse(clean);
}

/**
 * Normalizes raw LLM output into the strict AgentAction format, protecting against format variations.
 */
function normalizeAction(raw: any): AgentAction {
  let type = 'wait';
  const rawAction = raw.action;
  
  if (typeof rawAction === 'string') {
    type = rawAction;
  } else if (rawAction && typeof rawAction === 'object') {
    type = rawAction.type || 'wait';
  } else if (raw.type) {
    type = raw.type;
  }

  const selector = rawAction?.selector || raw.selector || undefined;
  const text = rawAction?.text || raw.text || undefined;
  const key = rawAction?.key || raw.key || undefined;
  const url = rawAction?.url || raw.url || undefined;
  const direction = rawAction?.direction || raw.direction || undefined;

  return {
    evaluation_previous_goal: raw.evaluation_previous_goal || 'Uncertain',
    memory: raw.memory || 'No memory recorded.',
    next_goal: raw.next_goal || 'Continue job search execution.',
    action: {
      type: type as any,
      selector,
      text,
      key,
      url,
      direction
    }
  };
}

/**
 * Extracts visible interactive elements from the current page state, assigning unique targets.
 */
async function getInteractiveElements(page: Page): Promise<InteractiveElement[]> {
  return await page.evaluate(() => {
    const doc = (globalThis as any).document;
    const win = (globalThis as any).window;
    const elements: InteractiveElement[] = [];
    
    // Find all likely interactive tags, including common custom component classes/roles
    const list = doc.querySelectorAll(
      'input, button, a, select, textarea, [role="button"], [role="option"], ' +
      '[role="listbox"] li, [role="tab"], [role="menuitem"], ' +
      '[class*="suggestion" i], [class*="selectable" i], [class*="typeahead" i] li, ' +
      '[class*="dropdown" i], [class*="dropdown" i] li, ' +
      '[class*="accordion" i], [class*="toggle" i], [class*="filter" i], ' +
      '[id*="accordion" i], [id*="toggle" i], [id*="filter" i]'
    );
    
    // Terms to ignore in text/href/class/id to strip footer, header, social media, policy links
    const ignoreRegex = /privacy|cookie|terms|legal|facebook|twitter|linkedin|instagram|youtube|about|contact|help|support|faq|press|news|blog|investor|shop|store|cart|checkout|login|signin|signup|register|logout|signout|copyright/i;
    
    list.forEach((el: any, index: number) => {
      const htmlEl = el as any;
      
      // Basic visibility check
      const style = win.getComputedStyle(htmlEl);
      const isVisible = style.display !== 'none' && 
                        style.visibility !== 'hidden' && 
                        htmlEl.offsetWidth > 0 && 
                        htmlEl.offsetHeight > 0;
                        
      if (!isVisible) return;

      // Determine if this custom element is interactive
      const tagName = htmlEl.tagName.toLowerCase();
      const hasPointerCursor = style.cursor === 'pointer';
      const isInteractiveTag = ['input', 'button', 'a', 'select', 'textarea'].includes(tagName);
      const hasInteractiveRole = htmlEl.getAttribute('role') !== null;
      const hasAriaAttributes = htmlEl.getAttribute('aria-expanded') !== null || htmlEl.getAttribute('aria-haspopup') !== null;
      
      if (!isInteractiveTag && !hasInteractiveRole && !hasAriaAttributes && !hasPointerCursor) {
        return;
      }

      const text = htmlEl.innerText?.substring(0, 50).trim() || '';
      const value = htmlEl.value || '';
      const href = htmlEl.getAttribute('href') || '';
      const id = htmlEl.id || '';
      const className = htmlEl.className || '';
      const ariaLabel = htmlEl.getAttribute('aria-label') || '';
      
      // Filter out empty elements unless they are inputs or have labels
      if (tagName !== 'input' && !text && !value && !ariaLabel) return;
      
      // Filter out footer, header, social, policy elements to keep prompt token size small
      const combinedInfo = `${text} ${href} ${id} ${className}`;
      if (ignoreRegex.test(combinedInfo)) {
        return;
      }
      
      // Assign unique data attribute for target tracking
      const attrName = 'data-agent-target';
      const attrVal = `target-${index}`;
      htmlEl.setAttribute(attrName, attrVal);
      const selector = `[${attrName}="${attrVal}"]`;
      
      elements.push({
        selector,
        tagName,
        type: htmlEl.getAttribute('type') || undefined,
        placeholder: htmlEl.getAttribute('placeholder') || undefined,
        role: htmlEl.getAttribute('role') || undefined,
        text: text || undefined,
        value: value || undefined,
        isVisible: true,
        ariaExpanded: htmlEl.getAttribute('aria-expanded') || undefined,
        ariaHasPopup: htmlEl.getAttribute('aria-haspopup') || undefined,
        ariaLabel: ariaLabel || undefined
      });
    });
    
    // Prioritize elements: 1. Inputs, 2. Autocomplete suggestions/dropdown options, 3. Buttons, 4. Others
    const getPriority = (el: InteractiveElement) => {
      if (el.tagName === 'input') return 1;
      if (el.role === 'option' || el.selector.includes('suggestion') || el.selector.includes('selectable') || el.selector.includes('dropdown')) return 2;
      if (el.tagName === 'button' || el.role === 'button') return 3;
      return 4;
    };
    
    elements.sort((a, b) => getPriority(a) - getPriority(b));
    
    // Limit to top 50 elements to absolutely stay well within token limits and focus on what's important
    return elements.slice(0, 50);
  });
}

/**
 * Calls the Groq Chat API directly using fetch fallback, utilizing available API keys.
 */
async function callGroqLLM(prompt: string, log: (msg: string) => void): Promise<string> {
  // 1. Try Gemini/Gemma first if the API key is present
  const geminiKey = process.env.GEMINI_API_KEY;
  if (geminiKey) {
    const modelName = process.env.GEMINI_MODEL || 'gemma-4-31b-it';
    try {
      log(`Attempting LLM call via Google Gemini API using model: ${modelName}...`);
      let response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${geminiKey}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            contents: [{
              parts: [{ text: prompt }]
            }],
            generationConfig: {
              responseMimeType: 'application/json',
              responseSchema: {
                type: 'OBJECT',
                properties: {
                  evaluation_previous_goal: { type: 'STRING' },
                  memory: { type: 'STRING' },
                  next_goal: { type: 'STRING' },
                  action: {
                    type: 'OBJECT',
                    properties: {
                      type: { type: 'STRING', enum: ['type', 'click', 'press', 'wait', 'navigate', 'scroll', 'done'] },
                      selector: { type: 'STRING' },
                      text: { type: 'STRING' },
                      key: { type: 'STRING' },
                      url: { type: 'STRING' },
                      direction: { type: 'STRING', enum: ['down', 'up'] }
                    },
                    required: ['type']
                  }
                },
                required: ['evaluation_previous_goal', 'memory', 'next_goal', 'action']
              }
            }
          })
        }
      );

      // Fallback if structured output responseSchema is rejected (HTTP 400)
      if (!response.ok && response.status === 400) {
        log(`Structured output responseSchema rejected by API. Retrying with simple JSON mode...`);
        response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${geminiKey}`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              contents: [{
                parts: [{ text: prompt }]
              }],
              generationConfig: {
                responseMimeType: 'application/json'
              }
            })
          }
        );
      }

      if (response.ok) {
        const data = await response.json() as any;
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) {
          log('Gemini call succeeded.');
          return text;
        }
      } else {
        const errorText = await response.text();
        log(`Gemini API returned error (${response.status}): ${errorText}. Falling back to Groq...`);
      }
    } catch (err: any) {
      log(`Gemini call failed: ${err.message}. Falling back to Groq...`);
    }
  }

  // 2. Fall back to Groq API keys
  log('Attempting LLM call via Groq API...');
  const keys = (process.env.GROQ_API_KEYS || process.env.GROQ_API_KEY || '')
    .split(',')
    .map(k => k.trim())
    .filter(Boolean);

  if (keys.length === 0) {
    throw new Error('No Groq API keys found, and Gemini API key is missing or failed.');
  }

  // Shuffle keys starting at a random index to distribute rate limits (load-balancing)
  const startIndex = Math.floor(Math.random() * keys.length);
  const rotatedKeys = [...keys.slice(startIndex), ...keys.slice(0, startIndex)];

  for (const key of rotatedKeys) {
    let retries = 0;
    const maxRetries = 3;
    
    while (retries < maxRetries) {
      try {
        const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${key}`
          },
          body: JSON.stringify({
            model: 'llama-3.3-70b-versatile',
            temperature: 0,
            response_format: { type: 'json_object' },
            messages: [
              {
                role: 'user',
                content: prompt
              }
            ]
          })
        });

        if (!response.ok) {
          const errorText = await response.text();
          
          if (response.status === 429 || errorText.includes('rate_limit_exceeded') || errorText.includes('Rate limit reached')) {
            retries++;
            let waitMs = 5000;
            const match = errorText.match(/try again in (\d+(\.\d+)?)s/i);
            if (match) {
              const seconds = parseFloat(match[1]);
              waitMs = Math.ceil(seconds * 1000) + 1500;
            } else {
              waitMs = 5000 * Math.pow(2, retries);
            }
            
            log(`Groq 429 Rate Limit hit. Sleeping for ${waitMs}ms before retry ${retries}/${maxRetries}...`);
            await new Promise(resolve => setTimeout(resolve, waitMs));
            continue;
          }
          
          throw new Error(`Groq API error (${response.status}): ${errorText}`);
        }

        const data = (await response.json()) as any;
        return data.choices[0].message.content;
      } catch (err: any) {
        if (retries >= maxRetries) {
          log(`Groq API key exhausted after ${maxRetries} retries. Error: ${err.message}`);
          break;
        }
        if (!err.message.includes('429') && !err.message.includes('rate_limit_exceeded') && !err.message.includes('Rate limit reached')) {
          log(`Groq API key failed. Error: ${err.message}`);
          break;
        }
      }
    }
  }

  throw new Error('All LLM providers (Gemini and Groq) failed or were exhausted.');
}

/**
 * Executes the Self-Healing Agentic Loop using play-by-play LLM instructions.
 */
async function runAgenticSearchLoop(
  page: Page,
  role: string,
  location: string,
  log: (msg: string) => void
): Promise<boolean> {
  log(`Starting self-healing agentic search loop for role: "${role}", location: "${location}"...`);
  
  const history: string[] = [];
  const maxSteps = 7;
  let memory = 'No memory yet. Just started.';
  let evaluation_previous_goal = 'First step. No previous action taken.';
  let next_goal = 'Locate keyword and location search inputs and prepare to execute search query.';
  
  for (let step = 1; step <= maxSteps; step++) {
    log(`[Agent Step ${step}/${maxSteps}] Assessing page state...`);
    
    // Get visible interactive elements and page URL
    const elements = await getInteractiveElements(page);
    const currentUrl = page.url();
    
    const elementsSummary = elements.map(el => 
      `- Selector: ${el.selector}\n` +
      `  Tag: ${el.tagName}${el.type ? ` (type: ${el.type})` : ''}\n` +
      `  Placeholder: ${el.placeholder || 'None'}\n` +
      `  Role: ${el.role || 'None'}\n` +
      `  Text: ${el.text ? `"${el.text}"` : 'None'}\n` +
      `  Current Value: ${el.value ? `"${el.value}"` : 'None'}\n` +
      `  AriaExpanded: ${el.ariaExpanded || 'None'}\n` +
      `  AriaHasPopup: ${el.ariaHasPopup || 'None'}\n` +
      `  AriaLabel: ${el.ariaLabel || 'None'}`
    ).join('\n');

    const prompt = `You are an Agentic Web Scraper. Your goal is to run a job search query on this company's careers portal.

Target Search Parameters:
- Keyword/Role: "${role}"
- Location: "${location}"

Current Page URL: ${currentUrl}

Visible Interactive Elements on Page:
${elementsSummary}

Execution History of Previous Steps:
${history.length > 0 ? history.map((h, i) => `${i+1}. ${h}`).join('\n') : 'No previous actions taken.'}

Memory:
${memory}

Previous Goal Evaluation:
${evaluation_previous_goal}

Next Goal:
${next_goal}

Goal Guidelines:
1. Locate and populate the keyword/role and location fields with the target parameters.
2. Self-Healing/Hidden Inputs: If a search input field is not visible, look for related filter toggles, accordion headers, dropdown buttons, or tab controls on the page and click them to reveal the hidden input. Observe "AriaExpanded" and "AriaHasPopup" fields in the elements list to find controls that open or expand sections.
3. Autocomplete: If entering text triggers an autocomplete suggestion list, select/click the correct suggestion from the list to finalize the selection. Do not submit the search with open dropdowns.
4. Submission: Click the search, submit, or find jobs button once parameters are set.
5. Exit Condition: If the current URL has transitioned to a search results page (e.g. query parameters are present) or search results are displayed, select the "done" action.
6. Recovery: If you are on the wrong page (e.g. redirected to an external site or a login wall), choose the "navigate" action and provide the correct career portal "url" to return.

Output format:
You must output a single JSON object conforming exactly to this schema:
{
  "evaluation_previous_goal": "One-sentence analysis of your last action. Verdict: Success / Failure / Uncertain",
  "memory": "1-3 sentences updated memory of this step and overall progress. Track what has been done, what is still pending, and how to avoid repeating failed attempts.",
  "next_goal": "State the next immediate goal and action to achieve it, in one clear sentence.",
  "action": {
    "type": "type" | "click" | "press" | "wait" | "navigate" | "scroll" | "done",
    "selector": "the exact CSS selector from the elements list (use double quotes inside JSON)",
    "text": "text to type if type action",
    "key": "key name to press if press action (e.g., 'Enter', 'ArrowDown')",
    "url": "destination URL if navigate action",
    "direction": "direction to scroll if scroll action ('down' or 'up')"
  }
}
Ensure your output contains ONLY the JSON object. Do not include any explanations outside the JSON.`;

    let actionObj: AgentAction | null = null;
    try {
      const responseText = await callGroqLLM(prompt, log);
      const parsed = parseLLMResponse(responseText);
      actionObj = normalizeAction(parsed);
      
      log(`Evaluation: ${actionObj.evaluation_previous_goal}`);
      log(`Memory: ${actionObj.memory}`);
      log(`Next Goal: ${actionObj.next_goal}`);
      log(`Action: ${actionObj.action.type} on ${actionObj.action.selector || actionObj.action.url || 'page'}`);
      
      memory = actionObj.memory;
      next_goal = actionObj.next_goal;
    } catch (parseErr: any) {
      log(`Failed to parse LLM response: ${parseErr.message}`);
      evaluation_previous_goal = `Failed to parse your last response as valid JSON: ${parseErr.message}. Make sure to output ONLY the valid JSON object format matching the schema.`;
      history.push(`Step ${step} Failure: Failed to parse LLM response.`);
      continue;
    }

    try {
      if (actionObj.action.type === 'done') {
        log('Agent completed the search successfully.');
        return true;
      }
      
      if (actionObj.action.type === 'type') {
        if (!actionObj.action.selector) throw new Error('Missing selector for type action');
        // Clear value first before typing
        await page.fill(actionObj.action.selector, '');
        await typeHumanLike(page, actionObj.action.selector, actionObj.action.text || '');
        await page.waitForTimeout(1000); // Wait for potential autocomplete dropdowns
      } else if (actionObj.action.type === 'click') {
        if (!actionObj.action.selector) throw new Error('Missing selector for click action');
        
        const loc = page.locator(actionObj.action.selector).first();
        try {
          // Attempt standard pointer click
          await loc.click({ timeout: 4000 });
        } catch (clickErr: any) {
          log(`Standard click failed: ${clickErr.message}. Falling back to JS-based evaluation click.`);
          // JS click fallback bypassing overlay interception
          await loc.evaluate((el: any) => el.click());
        }
        await page.waitForTimeout(1000);
      } else if (actionObj.action.type === 'press') {
        if (!actionObj.action.key) throw new Error('Missing key for press action');
        await page.keyboard.press(actionObj.action.key);
        await page.waitForTimeout(1000);
      } else if (actionObj.action.type === 'wait') {
        await page.waitForTimeout(2000);
      } else if (actionObj.action.type === 'navigate') {
        if (!actionObj.action.url) throw new Error('Missing url for navigate action');
        log(`Navigating to target URL: ${actionObj.action.url}`);
        await page.goto(actionObj.action.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(2000);
      } else if (actionObj.action.type === 'scroll') {
        const dir = actionObj.action.direction || 'down';
        log(`Scrolling page ${dir}...`);
        if (dir === 'down') {
          await page.evaluate(() => (globalThis as any).scrollBy(0, 500));
        } else {
          await page.evaluate(() => (globalThis as any).scrollBy(0, -500));
        }
        await page.waitForTimeout(1000);
      }
      
      // Let network rest
      await page.waitForLoadState('networkidle').catch(() => {});
      evaluation_previous_goal = `Action '${actionObj.action.type}' on selector '${actionObj.action.selector || 'N/A'}' succeeded.`;
      history.push(
        `Action: ${actionObj.action.type} on ${actionObj.action.selector || actionObj.action.url || 'page'} ` +
        `(Status: Success, Goal: ${actionObj.next_goal})`
      );
    } catch (execErr: any) {
      log(`Action execution failed: ${execErr.message}`);
      evaluation_previous_goal = `Action '${actionObj.action.type}' on selector '${actionObj.action.selector || 'N/A'}' failed: ${execErr.message}. Try selecting a different element, scrolling, or navigating.`;
      history.push(
        `Action: ${actionObj.action.type} on ${actionObj.action.selector || 'page'} ` +
        `(Status: Failed - ${execErr.message}, Goal: ${actionObj.next_goal})`
      );
    }
  }
  
  log('Agent reached maximum execution steps without finishing.');
  return false;
}

async function executeCompanyScrapeViaTinyFish(
  payload: WatcherJobPayload,
  log: (msg: string) => void
): Promise<ScrapeResult[]> {
  const results: ScrapeResult[] = [];
  const apiKey = process.env.TINYFISH_API_KEY;

  for (const search of payload.searches) {
    log(`Executing TinyFish search: "${search.role}" in "${search.location}" for ${payload.company}`);
    try {
      const response = await fetch("https://agent.tinyfish.ai/v1/automation/run", {
        method: "POST",
        headers: {
          "X-API-Key": apiKey || '',
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          url: payload.careerUrl,
          goal: `Search for jobs matching the role keyword "${search.role}" and location "${search.location}". If there is an autocomplete list or location dropdown suggestion, select it to apply the filter. Wait for the search results to load, then extract all the visible job postings.`,
          browser_profile: "stealth",
          output_schema: {
            type: "object",
            properties: {
              jobs: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    title: { type: "string" },
                    location: { type: "string" },
                    jobUrl: { type: "string" },
                    employmentType: { type: "string" },
                    remoteStatus: { type: "string" }
                  },
                  required: ["title", "location", "jobUrl"]
                }
              }
            },
            required: ["jobs"]
          }
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`TinyFish API Error (${response.status}): ${errorText}`);
      }

      const data = await response.json() as any;
      if (data.status !== "COMPLETED") {
        throw new Error(`TinyFish agent run completed with status: ${data.status}`);
      }

      const rawJobs = data.result?.jobs || [];
      const matchingJobs: NormalizedJob[] = rawJobs.map((job: any) => {
        let jobUrl = job.jobUrl || '';
        if (jobUrl && !jobUrl.startsWith('http')) {
          jobUrl = new URL(jobUrl, payload.careerUrl).toString();
        }
        const jobId = crypto.createHash('md5').update(`${payload.company}-${jobUrl}`).digest('hex');

        // Extract remote status & employment type
        let remoteStatus = 'On-site';
        let employmentType = 'Full-time';
        const rawText = `${job.title} ${job.location || ''} ${job.remoteStatus || ''} ${job.employmentType || ''}`.toLowerCase();
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

        return {
          jobId,
          company: payload.company,
          title: job.title.trim(),
          location: job.location?.trim() || 'Unknown',
          employmentType,
          remoteStatus,
          jobUrl,
          source: 'company_career_page',
        };
      });

      log(`TinyFish found ${matchingJobs.length} matching jobs for "${search.role}"`);

      results.push({
        searchId: search.searchId,
        jobs: matchingJobs,
        success: true,
        searchPageUrl: payload.careerUrl,
      });

    } catch (err: any) {
      log(`TinyFish search failed for "${search.role}": ${err.message}`);
      throw err; // Re-throw to trigger local scraper fallback
    }
  }

  return results;
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
      log('Could not find search inputs on landing page. Checking for transition buttons to the job board...');
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

      let navigated = false;
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

      let matchingJobs: NormalizedJob[] = [];
      try {

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
            const submitLoc = page.locator(selectors.submitSelector).first();
            try {
              await submitLoc.click({ timeout: 5000 });
            } catch (clickErr: any) {
              log(`Standard search click failed: ${clickErr.message}. Falling back to JS-based evaluation click.`);
              await submitLoc.evaluate((el: any) => el.click()).catch(() => {});
            }
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

        const locationFilterNotApplied = search.location && 
                                         search.location.toLowerCase() !== 'any' && 
                                         search.location.toLowerCase() !== 'remote' && 
                                         !selectors.locationSelector;

        // Fallback: If standard interactive search yielded 0 jobs, or location filter was not applied, run the Agentic Loop
        if (!isJobBoardAggregator && (matchingJobs.length === 0 || locationFilterNotApplied)) {
          if (locationFilterNotApplied) {
            log(`Heuristic search could not find a location input field, but search location is "${search.location}". Triggering Self-Healing Agentic Loop...`);
          } else {
            log('Heuristic interactive search yielded 0 jobs. Triggering Self-Healing Agentic Loop...');
          }
          try {
            // Reload original URL to start clean
            log(`Navigating back to initial career URL: ${payload.careerUrl}`);
            await page.goto(payload.careerUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await page.waitForTimeout(3000);
            await handleCookieBanners(page, log);
            
            const agentSuccess = await runAgenticSearchLoop(page, search.role, search.location, log);
            if (agentSuccess) {
              log('Agentic search completed successfully. Re-extracting jobs...');
              matchingJobs = await extractJobs(page, payload.company, payload.careerUrl);
            }
          } catch (agentErr: any) {
            log(`Agentic search loop failed: ${agentErr.message}`);
          }
        }

        if (matchingJobs.length === 0 && process.env.TINYFISH_API_KEY) {
          log(`Local search yielded 0 jobs. Falling back to TinyFish API for "${search.role}"...`);
          try {
            const tinyFishPayload = {
              company: payload.company,
              careerUrl: payload.careerUrl,
              searches: [search]
            };
            const tinyFishRes = await executeCompanyScrapeViaTinyFish(tinyFishPayload, log);
            if (tinyFishRes.length > 0 && tinyFishRes[0].success) {
              matchingJobs = tinyFishRes[0].jobs;
            }
          } catch (tfErr: any) {
            log(`TinyFish fallback execution failed: ${tfErr.message}`);
          }
        }

        log(`Found ${matchingJobs.length} matching jobs for "${search.role}"`);

        results.push({
          searchId: search.searchId,
          jobs: matchingJobs,
          success: true,
          searchPageUrl: page.url(),
        });

      } catch (err: any) {
        log(`Heuristic search failed: ${err.message}. Triggering Self-Healing Agentic Loop fallback...`);
        try {
          // Reload original URL to start clean
          log(`Navigating back to initial career URL: ${payload.careerUrl}`);
          await page.goto(payload.careerUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
          await page.waitForTimeout(3000);
          await handleCookieBanners(page, log);
          
          const agentSuccess = await runAgenticSearchLoop(page, search.role, search.location, log);
          if (agentSuccess) {
            log('Agentic search completed successfully. Extracting jobs...');
            matchingJobs = await extractJobs(page, payload.company, payload.careerUrl);
            log(`Found ${matchingJobs.length} matching jobs for "${search.role}"`);
          }
        } catch (agentErr: any) {
          log(`Agentic search loop fallback failed: ${agentErr.message}`);
        }

        if (matchingJobs.length === 0 && process.env.TINYFISH_API_KEY) {
          log(`Local agent fallback yielded 0 jobs or failed. Falling back to TinyFish API for "${search.role}"...`);
          try {
            const tinyFishPayload = {
              company: payload.company,
              careerUrl: payload.careerUrl,
              searches: [search]
            };
            const tinyFishRes = await executeCompanyScrapeViaTinyFish(tinyFishPayload, log);
            if (tinyFishRes.length > 0 && tinyFishRes[0].success) {
              matchingJobs = tinyFishRes[0].jobs;
            }
          } catch (tfErr: any) {
            log(`TinyFish fallback execution failed: ${tfErr.message}`);
          }
        }

        if (matchingJobs.length > 0) {
          results.push({
            searchId: search.searchId,
            jobs: matchingJobs,
            success: true,
            searchPageUrl: page.url(),
          });
        } else {
          log(`Error executing search: ${err.message}`);
          results.push({
            searchId: search.searchId,
            jobs: [],
            success: false,
            error: err.message,
          });
        }

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
    log(`Fatal local batch failure: ${err.message}`);
    
    if (process.env.TINYFISH_API_KEY) {
      log('Falling back to TinyFish API for all remaining searches...');
      const pendingSearches = payload.searches.filter(
        search => !results.find(r => r.searchId === search.searchId)
      );
      
      if (pendingSearches.length > 0) {
        try {
          const tinyFishPayload = {
            company: payload.company,
            careerUrl: payload.careerUrl,
            searches: pendingSearches
          };
          const tfResults = await executeCompanyScrapeViaTinyFish(tinyFishPayload, log);
          results.push(...tfResults);
        } catch (tfErr: any) {
          log(`TinyFish batch fallback failed: ${tfErr.message}`);
          // Push failure for remaining
          for (const search of pendingSearches) {
            results.push({
              searchId: search.searchId,
              jobs: [],
              success: false,
              error: `Local fatal error: ${err.message}. TinyFish fallback error: ${tfErr.message}`,
            });
          }
        }
      }
    } else {
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
    }
  } finally {
    if (page) await page.close().catch(() => {});
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    log('Anti-detect browser session closed.');
  }

  return results;
}
