import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job as BullJob } from 'bullmq';
import { Logger } from '@nestjs/common';
import { chromium, Browser, BrowserContext } from 'playwright';
import { DatabaseService } from '../../vector-store/database.service';
import { LlmGatewayService } from '../../llm-gateway/llm-gateway.service';
import { CustomConfigProvider } from '../providers/custom-config.provider';

interface WatcherDiscoveryPayload {
  userId: number;
  companyName: string;
  url: string;
  domain: string;
}

@Processor('watcher-discovery', { concurrency: 1 })
export class WatcherDiscoveryWorker extends WorkerHost {
  private readonly logger = new Logger(WatcherDiscoveryWorker.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly llm: LlmGatewayService,
    private readonly customConfig: CustomConfigProvider
  ) {
    super();
  }

  async process(job: BullJob<WatcherDiscoveryPayload>): Promise<any> {
    const { companyName, url, domain } = job.data;
    this.logger.log(`Starting dynamic discovery for ${companyName} (${url})...`);

    // Update DB status to processing
    await this.db.query(
      `UPDATE discovery_queue_jobs SET status = 'processing', updated_at = CURRENT_TIMESTAMP WHERE domain = $1`,
      [domain]
    );

    let browser: Browser | null = null;
    let context: BrowserContext | null = null;
    const capturedEndpoints: { url: string; method: string; requestHeaders: any; requestPayload: string; responseBodySnippet: string }[] = [];

    try {
      // 1. Launch headless browser
      browser = await chromium.launch({
        headless: true,
        args: [
          '--disable-blink-features=AutomationControlled',
          '--disable-infobars',
          '--window-size=1280,720',
        ],
      });

      context = await browser.newContext({
        viewport: { width: 1280, height: 720 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      });

      const page = await context.newPage();
      page.setDefaultTimeout(20000);

      // 2. Setup response listener to capture XHR/Fetch calls returning JSON or HTML containing state
      page.on('response', async (response) => {
        const req = response.request();
        const resHeaders = response.headers();
        const contentType = (resHeaders['content-type'] || resHeaders['Content-Type'] || '').toLowerCase();

        const urlLower = req.url().toLowerCase();
        const shouldIgnore = 
          urlLower.includes('onetrust') ||
          urlLower.includes('cookielaw') ||
          urlLower.includes('analytics') ||
          urlLower.includes('doubleclick') ||
          urlLower.includes('linkedin') ||
          urlLower.includes('facebook') ||
          urlLower.includes('reddit') ||
          urlLower.includes('clarity') ||
          urlLower.includes('hotjar') ||
          urlLower.includes('chatbot') ||
          urlLower.includes('pixel') ||
          urlLower.includes('collect') ||
          urlLower.includes('telemetry') ||
          urlLower.includes('marketing') ||
          urlLower.includes('tagmanager') ||
          urlLower.includes('visitor');

        if (shouldIgnore) return;

        const isJson = (req.resourceType() === 'fetch' || req.resourceType() === 'xhr') && contentType.includes('application/json');
        const isDocument = req.resourceType() === 'document' && contentType.includes('text/html');

        if (isJson || isDocument) {
          try {
            const text = await response.text();
            
            let isMatch = false;
            if (isJson) {
              const textLower = text.toLowerCase();
              const hasJobList = 
                textLower.includes('"jobs"') || 
                textLower.includes('"results"') || 
                textLower.includes('"postings"') ||
                textLower.includes('"requisitions"') ||
                textLower.includes('"positions"');

              const hasJobFields = 
                textLower.includes('"title"') && 
                (textLower.includes('"location"') || textLower.includes('"jobid"') || textLower.includes('"reqid"'));

              isMatch = hasJobList || hasJobFields;
            } else {
              isMatch = text.includes('phApp.ddo') || text.includes('__PRELOADED_STATE__') || text.includes('application/ld+json');
            }

            if (isMatch) {
              capturedEndpoints.push({
                url: req.url(),
                method: req.method(),
                requestHeaders: req.headers(),
                requestPayload: req.postData() || '',
                responseBodySnippet: text.substring(0, 2000), // snippet for LLM context
              });
            }
          } catch {}
        }
      });

      // 3. Navigate to page
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(4000);

      // 4. Click common career buttons to trigger AJAX loading if needed
      const selectors = [
        'text="Jobs"', 'text="Careers"', 'text="Search Jobs"', 'text="Openings"',
        'button:has-text("Search")', 'a:has-text("Search")', '[placeholder*="Search"]'
      ];

      for (const selector of selectors) {
        try {
          const el = await page.$(selector);
          if (el && await el.isVisible()) {
            await el.click();
            await page.waitForTimeout(2000);
          }
        } catch {}
      }

      // 5. Always perform search input interaction to type query and trigger search parameters/payloads
      this.logger.log('Performing search input interaction to trigger query parameter/payload...');
      try {
        const inputs = await page.$$('input');
        let typed = false;
        for (const input of inputs) {
          const type = await input.getAttribute('type');
          const placeholder = await input.getAttribute('placeholder') || '';
          if (type === 'text' || !type || placeholder.toLowerCase().includes('search') || placeholder.toLowerCase().includes('role') || placeholder.toLowerCase().includes('keyword')) {
            const isVisible = await input.isVisible();
            if (isVisible) {
              await input.fill('Software');
              await page.keyboard.press('Enter');
              typed = true;
              break;
            }
          }
        }
        if (typed) {
          await page.waitForTimeout(6000);
        }
      } catch (inputErr) {
        this.logger.warn(`Search input interaction failed: ${inputErr.message}`);
      }

      // Allow final requests to complete
      await page.waitForTimeout(3000);

      if (capturedEndpoints.length === 0) {
        throw new Error('No JSON or SSR HTML job endpoints captured during career page load.');
      }

      // 5. Ask LLM to analyze the captured traffic
      this.logger.log(`Captured ${capturedEndpoints.length} potential JSON endpoints. Analyzing with LLM...`);
      
      const prompt = `
You are an expert systems engineer and API analyzer.
We monitored network requests during a browser load of a company's career page.
Identify which intercepted URL returns the active job openings list.

CRITICAL:
1. Identify how the API filters or queries by job role/title and location.
In your returned "endpointUrl" or "payload", replace any values representing search keywords/role (e.g. "Software", "Developer") with the placeholder "{{role}}" and location values with "{{location}}".
For example:
- If endpointUrl was "https://example.com/api/jobs?q=Software&l=London", return: "endpointUrl": "https://example.com/api/jobs?q={{role}}&l={{location}}"
- If payload was {"query": "Software", "location": "London"}, return: "payload": {"query": "{{role}}", "location": "{{location}}"}

2. Support for Server-Side Rendered (SSR) HTML Documents:
If the job openings list is server-side rendered directly in the HTML document on load (instead of a separate JSON API endpoint), choose the GET request of the HTML landing page as the "endpointUrl" (including any query parameters like "?keywords={{role}}&location={{location}}").
Then, identify where the jobs data is initialized inside an inline script block (e.g. in a global variable assignment like "phApp.ddo = {...}" or a JSON-LD script "<script type=\"application/ld+json\">").
Set "jobListPath" to the dot-notation path relative to that extracted JSON state object. For example: "eagerLoadRefineSearch.data.jobs" or "0.hasPart" (if it is the first JSON-LD object).

Interceptors:
${JSON.stringify(capturedEndpoints.slice(0, 8), null, 2)}

Return a JSON markdown block that matches this exact schema:
{
  "isFound": boolean,
  "endpointUrl": "string",
  "method": "GET" | "POST",
  "headers": {},
  "payload": {}, // JSON body if POST/PUT, null if GET
  "mapping": {
    "jobListPath": "string", // Dot-notation path to job array (e.g., "jobs" or "results" or "body.postings" or "eagerLoadRefineSearch.data.jobs"). If array is index-based, e.g. at response[0][2], use "0.2".
    "externalId": "string",  // Field representing unique ID relative to job item (e.g. "id" or "jobId" or "reqId"). If job item is an array, use numeric index string (e.g. "0").
    "title": "string",       // Field for job title (e.g. "title" or "name"). If job item is an array, use numeric index string (e.g. "1").
    "location": "string",    // Field for location (e.g. "location" or "office.name"). If job item is an array, use numeric index string (e.g. "9.0.0").
    "description": "string", // Field for job description/snippet (e.g. "descriptionTeaser" or "snippet"). If job item is an array, use numeric index string (e.g. "10").
    "applyUrl": "string"     // Field for absolute apply URL (e.g. "applyUrl" or "link"). If job item is an array, use numeric index string (e.g. "2").
  },
  "explanation": "string explaining your decision"
}
`;

      let llmResult: any = null;
      let validationError: string | null = null;
      let attempt = 1;
      const maxAttempts = 3;
      const attemptHistory: string[] = [];

      while (attempt <= maxAttempts) {
        this.logger.log(`LLM Analysis and validation attempt ${attempt}/${maxAttempts} for ${companyName}...`);

        let feedbackPrompt = prompt;
        if (attemptHistory.length > 0) {
          feedbackPrompt += `
\n\n
CRITICAL: The previous configurations you generated failed validation with errors.
Please review the errors below and correct the configuration (headers, endpointUrl, payload nesting, or mapping paths) to make it succeed:
${attemptHistory.map((h, i) => `[Attempt ${i + 1} Error]:\n${h}`).join('\n\n')}
`;
        }

        const responseText = await this.llm.invokeLLM(async (model) => {
          const res = await model.invoke(feedbackPrompt);
          return res.content as string;
        });

        let cleanedJson: string;
        try {
          cleanedJson = this.cleanJsonText(responseText);
          llmResult = JSON.parse(cleanedJson);
        } catch (parseErr) {
          const errStr = `Failed to parse LLM response JSON: ${parseErr.message}. Output was: ${responseText.substring(0, 300)}`;
          this.logger.warn(errStr);
          attemptHistory.push(errStr);
          attempt++;
          continue;
        }

        if (!llmResult.isFound) {
          throw new Error('LLM was unable to identify a job list endpoint in the captured requests.');
        }

        // Test the configuration by executing a test call
        try {
          this.logger.log(`Testing candidate configuration for ${companyName}...`);
          
          // Substitute mock/test strings into placeholders
          let configStr = JSON.stringify(llmResult);
          configStr = configStr
            .replace(/\{\{role\}\}/g, 'Software')
            .replace(/\{\{location\}\}/g, '');
          const testConfig = JSON.parse(configStr);

          const fetchedJobs = await this.customConfig.fetchJobsWithConfig(companyName, testConfig);

          if (!fetchedJobs || fetchedJobs.length === 0) {
            throw new Error(`The HTTP call succeeded but resolved 0 jobs. This means the mapping paths (jobListPath, title, externalId) are incorrect, or the payload query values did not match.`);
          }

          this.logger.log(`Validation successful! Resolved ${fetchedJobs.length} test jobs on attempt ${attempt}.`);
          validationError = null;
          break; // Validation succeeded!
        } catch (valErr) {
          const errStr = `Validation failed: ${valErr.message}`;
          this.logger.warn(errStr);
          attemptHistory.push(errStr);
          validationError = valErr.message;
          attempt++;
        }
      }

      if (validationError) {
        throw new Error(`Failed to validate custom configuration after ${maxAttempts} attempts. Last error: ${validationError}`);
      }

      // 6. Save discovered configuration to staging table
      await this.db.query(
        `UPDATE discovery_queue_jobs 
         SET status = 'completed', 
             discovered_endpoint = $1, 
             discovered_payload = $2,
             updated_at = CURRENT_TIMESTAMP
         WHERE domain = $3`,
        [llmResult.endpointUrl, llmResult, domain]
      );

      this.logger.log(`Successfully discovered and validated job endpoint for ${companyName}! Saved config pending approval.`);
      return { success: true, endpoint: llmResult.endpointUrl };

    } catch (err) {
      this.logger.error(`Discovery failed for ${companyName}: ${err.message}`, err.stack);
      await this.db.query(
        `UPDATE discovery_queue_jobs 
         SET status = 'failed', 
             error_message = $1, 
             updated_at = CURRENT_TIMESTAMP 
         WHERE domain = $2`,
        [err.message, domain]
      );
      throw err;
    } finally {
      if (browser) {
        await browser.close();
      }
    }
  }

  private cleanJsonText(text: string): string {
    let cleaned = text.trim();
    const codeBlockRegex = /```(?:json|markdown|)\s*([\s\S]*?)\s*```/i;
    const match = cleaned.match(codeBlockRegex);
    if (match && match[1]) {
      cleaned = match[1].trim();
    }
    if (!cleaned.startsWith('{') && !cleaned.startsWith('[')) {
      const firstBrace = cleaned.indexOf('{');
      const lastBrace = cleaned.lastIndexOf('}');
      if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
        cleaned = cleaned.substring(firstBrace, lastBrace + 1);
      }
    }
    return cleaned;
  }
}
