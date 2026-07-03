import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { DatabaseService } from '../vector-store/database.service';
import { LlmGatewayService } from '../llm-gateway/llm-gateway.service';
import { NotifierService } from '../notifier/notifier.service';

@Injectable()
export class CompanyWatcherService implements OnModuleInit {
  private readonly logger = new Logger(CompanyWatcherService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly llmGateway: LlmGatewayService,
    private readonly notifier: NotifierService,
    @InjectQueue('career-watcher-tasks') private readonly watcherQueue: Queue,
  ) {}

  /**
   * Automatically starts the periodic background scraping cron on application boot.
   * Runs 30 seconds after startup, then every 2 hours.
   */
  onModuleInit() {
    this.logger.log('[COMPANY-WATCHER] Initializing background scheduler loop...');
    
    // Initial run after 30 seconds
    setTimeout(() => {
      this.triggerCronJob().catch((err) => {
        this.logger.error(`[COMPANY-WATCHER] Scheduled run failed: ${err.message}`);
      });
    }, 30000);

    // Periodic run every 2 hours
    setInterval(() => {
      this.triggerCronJob().catch((err) => {
        this.logger.error(`[COMPANY-WATCHER] Scheduled run failed: ${err.message}`);
      });
    }, 2 * 60 * 60 * 1000);
  }

  /**
   * Dynamically resolves the user ID. Returns the first user found in the DB.
   * If the users table is completely empty, it seeds a default user with ID 1.
   */
  async resolveUserId(providedUserId: number): Promise<number> {
    try {
      const res = await this.db.query('SELECT id FROM users ORDER BY id ASC LIMIT 1');
      if (res.rows.length > 0) {
        return res.rows[0].id;
      }
      
      this.logger.log('[COMPANY-WATCHER] No users found in database. Seeding default user with ID 1 to prevent foreign key violations...');
      await this.db.query(`
        INSERT INTO users (id, full_name, email)
        VALUES (1, 'Default Candidate', 'default@careeratlas.com')
        ON CONFLICT (id) DO NOTHING
      `);
      return 1;
    } catch (err: any) {
      this.logger.error(`[COMPANY-WATCHER] Error resolving user ID: ${err.message}`);
      return providedUserId;
    }
  }

  /**
   * One-time discovery of a company's career page using LLM
   */
  async discoverCareerUrl(companyName: string): Promise<string> {
    this.logger.log(`[COMPANY-WATCHER] Running one-time discovery for company: "${companyName}"...`);
    const prompt = `Given the company name "${companyName}", what is the official URL of their direct public job postings / search portal?
We need the actual page where candidates search and view open roles, NOT the generic corporate marketing / "about careers" landing page. 
Prefer standard direct job search portal URLs such as "jobs.${companyName.toLowerCase().replace(/\s+/g, '')}.com" or "careers.${companyName.toLowerCase().replace(/\s+/g, '')}.com" or their specific direct job board search directory.
You MUST respond with ONLY the absolute URL. No explanation, no conversational filler, no markdown formatting (like backticks or code blocks).
Example: For "Google", respond with "https://careers.google.com/jobs/results/".
Example: For "Microsoft", respond with "https://careers.microsoft.com/us/en/search-results".`;

    try {
      const responseText = await this.llmGateway.invokeLLM(async (model) => {
        const response = await model.invoke(prompt);
        return String(response.content).trim();
      });

      const cleanedUrl = responseText.replace(/`/g, '').trim();
      if (!cleanedUrl.startsWith('http')) {
        throw new Error(`Invalid URL returned from LLM: "${cleanedUrl}"`);
      }

      this.logger.log(`[COMPANY-WATCHER] Discovered career URL for ${companyName}: "${cleanedUrl}"`);
      return cleanedUrl;
    } catch (err: any) {
      this.logger.error(`[COMPANY-WATCHER] Failed to discover career URL for ${companyName}: ${err.message}`);
      // Fallback search link
      return `https://www.google.com/search?q=${encodeURIComponent(companyName + ' careers')}`;
    }
  }

  /**
   * Saves a user watch preference, runs instant database checks, sends alerts, and triggers a scrape job
   */
  async addWatch(userId: number, companyName: string, role: string, location: string): Promise<any> {
    const resolvedUserId = await this.resolveUserId(userId);
    const normalizedCompany = companyName.trim();
    const normalizedRole = role.trim();
    const normalizedLocation = location.trim();

    // 1. Ensure the company career URL exists
    const companyRes = await this.db.query(
      'SELECT career_url FROM company_careers WHERE LOWER(company_name) = LOWER($1)',
      [normalizedCompany]
    );

    let careerUrl = '';
    if (companyRes.rows.length === 0) {
      careerUrl = await this.discoverCareerUrl(normalizedCompany);
      await this.db.query(
        'INSERT INTO company_careers (company_name, career_url) VALUES ($1, $2) ON CONFLICT (company_name) DO NOTHING',
        [normalizedCompany, careerUrl]
      );
    } else {
      careerUrl = companyRes.rows[0].career_url;
    }

    // 2. Check if the watch already exists in the database
    const existingWatch = await this.db.query(
      `SELECT id FROM user_career_watches 
       WHERE user_id = $1 AND LOWER(company_name) = LOWER($2) AND LOWER(role) = LOWER($3) AND LOWER(location) = LOWER($4)`,
      [resolvedUserId, normalizedCompany, normalizedRole, normalizedLocation]
    );

    const isAlreadyInserted = existingWatch.rows.length > 0;

    // 3. Add or update watch preference (upsert so created_at updates)
    const res = await this.db.query(
      `INSERT INTO user_career_watches (user_id, company_name, role, location)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, company_name, role, location) DO UPDATE 
       SET created_at = CURRENT_TIMESTAMP
       RETURNING id, company_name as "companyName", role, location`,
      [resolvedUserId, normalizedCompany, normalizedRole, normalizedLocation]
    );

    const watchId = res.rows[0].id;

    // 4. Instantly alert of any matching jobs already stored in the results database
    try {
      const existingJobsRes = await this.db.query(
        `SELECT job_id as "jobId", title, url 
         FROM results
         WHERE LOWER(company) = LOWER($1)
           AND LOWER(title) LIKE LOWER($2)
           AND LOWER(location) LIKE LOWER($3)`,
        [normalizedCompany, `%${normalizedRole.toLowerCase()}%`, `%${normalizedLocation.toLowerCase()}%`]
      );

      let instantAlertCount = 0;
      for (const job of existingJobsRes.rows) {
        // Try inserting into notifications to deduplicate
        const insertNotif = await this.db.query(
          `INSERT INTO user_watch_notifications (user_id, job_id)
           VALUES ($1, $2)
           ON CONFLICT (user_id, job_id) DO NOTHING
           RETURNING 1`,
          [resolvedUserId, job.jobId]
        );

        if (insertNotif.rows.length > 0) {
          // Send instant Telegram alert
          await this.notifier.sendWatcherAlert(
            normalizedCompany,
            normalizedRole,
            normalizedLocation,
            job.title,
            job.url || ''
          );
          instantAlertCount++;
        }
      }

      if (instantAlertCount > 0) {
        this.logger.log(`[COMPANY-WATCHER] Instantly alerted user ${resolvedUserId} of ${instantAlertCount} matching job(s) already in database.`);
      }
    } catch (err: any) {
      this.logger.error(`[COMPANY-WATCHER] Failed to query existing jobs for instant alert: ${err.message}`);
    }

    // 5. Instantly trigger a background browser scrape job specifically for this query combo
    await this.watcherQueue.add('scrape-company-career-page', {
      company: normalizedCompany,
      careerUrl,
      searches: [{
        searchId: `${resolvedUserId}_${watchId}`,
        role: normalizedRole,
        location: normalizedLocation
      }]
    }, {
      jobId: `instant_${resolvedUserId}_${watchId}_${Date.now()}`,
      attempts: 2,
      backoff: 15000,
    });

    this.logger.log(`[COMPANY-WATCHER] Watch processed. Instantly enqueued scrape job for watch ID ${watchId} (already existed: ${isAlreadyInserted})`);

    return { 
      ...res.rows[0], 
      careerUrl,
      isAlreadyInserted,
    };
  }

  /**
   * Removes a user watch preference
   */
  async removeWatch(userId: number, watchId: number): Promise<void> {
    const resolvedUserId = await this.resolveUserId(userId);
    await this.db.query(
      'DELETE FROM user_career_watches WHERE user_id = $1 AND id = $2',
      [resolvedUserId, watchId]
    );
    this.logger.log(`[COMPANY-WATCHER] Watch ID ${watchId} removed for User ID ${resolvedUserId}`);
  }

  /**
   * Returns all active watches for a user
   */
  async getWatches(userId: number): Promise<any[]> {
    const resolvedUserId = await this.resolveUserId(userId);
    const res = await this.db.query(
      `SELECT w.id, w.company_name as "companyName", w.role, w.location, w.created_at as "createdAt", c.career_url as "careerUrl"
       FROM user_career_watches w
       LEFT JOIN company_careers c ON LOWER(w.company_name) = LOWER(c.company_name)
       WHERE w.user_id = $1
       ORDER BY w.company_name ASC, w.created_at DESC`,
      [resolvedUserId]
    );
    return res.rows;
  }

  /**
   * Main driver: Groups active watches by company and enqueues browser scraping batches
   */
  async triggerCronJob(): Promise<void> {
    this.logger.log('[COMPANY-WATCHER] Starting company career watcher batch run...');

    // 1. Fetch all watches
    const watchesRes = await this.db.query(
      `SELECT w.id as "watchId", w.user_id as "userId", w.company_name as "companyName", 
              w.role, w.location, c.career_url as "careerUrl"
       FROM user_career_watches w
       JOIN company_careers c ON LOWER(w.company_name) = LOWER(c.company_name)`
    );

    if (watchesRes.rows.length === 0) {
      this.logger.log('[COMPANY-WATCHER] No active watches found in database. Skipping.');
      return;
    }

    // 2. Group by company
    const companyBatches: Record<string, { careerUrl: string; searches: any[] }> = {};
    for (const row of watchesRes.rows) {
      const company = row.companyName;
      if (!companyBatches[company]) {
        companyBatches[company] = {
          careerUrl: row.careerUrl,
          searches: [],
        };
      }
      companyBatches[company].searches.push({
        searchId: `${row.userId}_${row.watchId}`, // Composite ID for callback tracing
        role: row.role,
        location: row.location,
      });
    }

    // 3. Dispatch to BullMQ
    let dispatchCount = 0;
    for (const [company, data] of Object.entries(companyBatches)) {
      const payload = {
        company,
        careerUrl: data.careerUrl,
        searches: data.searches,
      };

      await this.watcherQueue.add('scrape-company-career-page', payload, {
        jobId: `company_${company.toLowerCase()}_${Date.now()}`,
        attempts: 2,
        backoff: 15000,
      });

      this.logger.log(`[COMPANY-WATCHER] Enqueued scraping job for company: ${company} with ${data.searches.length} query combinations.`);
      dispatchCount++;
    }

    this.logger.log(`[COMPANY-WATCHER] Completed cron dispatch. ${dispatchCount} company-wide scrape batches enqueued.`);
  }
}
