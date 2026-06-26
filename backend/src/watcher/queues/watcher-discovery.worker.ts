import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job as BullJob } from 'bullmq';
import { Logger } from '@nestjs/common';
import { chromium, Browser, BrowserContext } from 'playwright';
import { DatabaseService } from '../../vector-store/database.service';
import { LlmGatewayService } from '../../llm-gateway/llm-gateway.service';

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
    private readonly llm: LlmGatewayService
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

      // 2. Setup response listener to capture XHR/Fetch calls returning JSON
      page.on('response', async (response) => {
        const req = response.request();
        const resHeaders = response.headers();
        const contentType = resHeaders['content-type'] || '';

        if (
          (req.resourceType() === 'fetch' || req.resourceType() === 'xhr') &&
          contentType.includes('application/json')
        ) {
          try {
            const text = await response.text();
            
            // Keep JSON payloads containing job list hints (e.g. title, jobs, departments, search)
            if (
              text.includes('title') || 
              text.includes('job') || 
              text.includes('posting') ||
              text.includes('career')
            ) {
              capturedEndpoints.push({
                url: req.url(),
                method: req.method(),
                requestHeaders: req.headers(),
                requestPayload: req.postData() || '',
                responseBodySnippet: text.substring(0, 1500), // snippet for LLM context
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

      // If no initial endpoints captured, interact with search inputs (crucial for SSR + search-based sites like Google)
      if (capturedEndpoints.length === 0) {
        this.logger.log('No initial JSON endpoints captured. Attempting input search interaction...');
        try {
          const inputs = await page.$$('input');
          for (const input of inputs) {
            const type = await input.getAttribute('type');
            if (type === 'text' || !type) {
              const isVisible = await input.isVisible();
              if (isVisible) {
                await input.fill('Software');
                await page.keyboard.press('Enter');
                await page.waitForTimeout(4000);
                break;
              }
            }
          }
        } catch (inputErr) {
          this.logger.warn(`Search input interaction failed: ${inputErr.message}`);
        }
      }

      // Allow final requests to complete
      await page.waitForTimeout(3000);

      if (capturedEndpoints.length === 0) {
        throw new Error('No JSON job endpoints captured during career page load.');
      }

      // 5. Ask LLM to analyze the captured traffic
      this.logger.log(`Captured ${capturedEndpoints.length} potential JSON endpoints. Analyzing with LLM...`);
      
      const prompt = `
You are an expert systems engineer and API analyzer.
We monitored network requests during a browser load of a company's career page.
Identify which intercepted URL returns the active job openings list.

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
    "jobListPath": "string", // Dot-notation path to job array (e.g., "jobs" or "results" or "body.postings")
    "externalId": "string",  // Field representing unique ID relative to job item (e.g. "id" or "jobId")
    "title": "string",       // Field for job title (e.g. "title" or "name")
    "location": "string",    // Field for location (e.g. "location" or "office.name")
    "description": "string", // Field for job description/snippet
    "applyUrl": "string"     // Field for absolute apply URL (e.g. "apply_url" or "link")
  },
  "explanation": "string explaining your decision"
}
`;

      const responseText = await this.llm.invokeLLM(async (model) => {
        const res = await model.invoke(prompt);
        return res.content as string;
      });

      const cleanedJson = this.cleanJsonText(responseText);
      const llmResult = JSON.parse(cleanedJson);

      if (!llmResult.isFound) {
        throw new Error('LLM was unable to identify a job list endpoint in the captured requests.');
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

      this.logger.log(`Successfully discovered job endpoint for ${companyName}! Saved config pending approval.`);
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
