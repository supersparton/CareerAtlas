import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { DatabaseService } from '../vector-store/database.service';
import { CompanyResolverService } from './company-resolver.service';
import { GreenhouseProvider } from './providers/greenhouse.provider';
import { LeverProvider } from './providers/lever.provider';
import { AshbyProvider } from './providers/ashby.provider';
import { WorkdayProvider } from './providers/workday.provider';
import { ICIMSProvider } from './providers/icims.provider';
import { CustomConfigProvider } from './providers/custom-config.provider';
import { RawJob } from './providers/provider.interface';

@Injectable()
export class WatcherService {
  private readonly logger = new Logger(WatcherService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly resolver: CompanyResolverService,
    private readonly greenhouse: GreenhouseProvider,
    private readonly lever: LeverProvider,
    private readonly ashby: AshbyProvider,
    private readonly workday: WorkdayProvider,
    private readonly icims: ICIMSProvider,
    private readonly customConfig: CustomConfigProvider,
    @InjectQueue('watcher-discovery') private readonly discoveryQueue: Queue
  ) {}

  /**
   * Main entry point when a user requests to watch a company career site
   */
  async watchCompany(
    userEmail: string | undefined,
    companyName: string,
    url: string,
    locationFilter?: string,
    roleFilter?: string
  ): Promise<{ status: string; message: string; companyId?: number }> {
    const email = (userEmail || 'default@example.com').trim().toLowerCase();
    this.logger.log(`User email ${email} requested to watch company "${companyName}" (${url}) with filters: location=${locationFilter}, role=${roleFilter}`);

    // 1. Resolve or create user to prevent foreign key violations
    const userRes = await this.db.query(
      `INSERT INTO users (full_name, email, phone)
       VALUES ($1, $2, $3)
       ON CONFLICT (email)
       DO UPDATE SET email = EXCLUDED.email
       RETURNING id`,
      ['Default User', email, '']
    );
    const userId = userRes.rows[0].id;

    // A. Check if the company already exists in watched_companies (by name, or by URL domain)
    let domainStr = '';
    try {
      domainStr = new URL(url).hostname.replace('www.', '').toLowerCase();
    } catch {
      domainStr = companyName.toLowerCase() + '.com';
    }

    const existingRes = await this.db.query(
      `SELECT * FROM watched_companies WHERE LOWER(name) = $1 OR LOWER(domain) = $2 OR LOWER(domain) = $3`,
      [companyName.toLowerCase(), domainStr, `www.${domainStr}`]
    );

    if (existingRes.rows.length > 0) {
      const company = existingRes.rows[0];
      const companyId = company.id;
      this.logger.log(`Company "${companyName}" already exists in watched_companies (id: ${companyId}, provider: ${company.provider_type}). Reusing config.`);

      // Link user to company with filters
      await this.db.query(
        `INSERT INTO job_watchers (user_id, company_id, location_filter, role_filter)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, company_id) 
         DO UPDATE SET location_filter = EXCLUDED.location_filter, role_filter = EXCLUDED.role_filter`,
        [userId, companyId, locationFilter || null, roleFilter || null]
      );

      // Trigger immediate background sync of jobs for this company
      this.syncJobsForCompany(companyId).catch((err) =>
        this.logger.error(`Error in immediate job sync for company ${companyId}: ${err.message}`)
      );

      return {
        status: 'resolved',
        message: `Successfully watching ${companyName} (reused existing configuration).`,
        companyId,
      };
    }

    // Resolve company career page
    const resolution = await this.resolver.resolveCompany(companyName, url);

    if (resolution.providerType !== 'unknown') {
      // 2. ATS Detected - Save/update watched company
      const companyResult = await this.db.query(
        `INSERT INTO watched_companies (name, domain, provider_type, provider_slug, status)
         VALUES ($1, $2, $3, $4, 'active')
         ON CONFLICT (name) 
         DO UPDATE SET domain = EXCLUDED.domain, provider_type = EXCLUDED.provider_type, provider_slug = EXCLUDED.provider_slug
         RETURNING id`,
        [companyName, resolution.domain, resolution.providerType, resolution.providerSlug]
      );

      const companyId = companyResult.rows[0].id;

      // 3. Link user to company with filters
      await this.db.query(
        `INSERT INTO job_watchers (user_id, company_id, location_filter, role_filter)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, company_id) 
         DO UPDATE SET location_filter = EXCLUDED.location_filter, role_filter = EXCLUDED.role_filter`,
        [userId, companyId, locationFilter || null, roleFilter || null]
      );

      // Trigger immediate background sync of jobs for this company
      this.syncJobsForCompany(companyId).catch((err) =>
        this.logger.error(`Error in immediate job sync for company ${companyId}: ${err.message}`)
      );

      return {
        status: 'resolved',
        message: `Successfully resolved company. Watching ${companyName} via ${resolution.providerType} provider.`,
        companyId,
      };
    } else {
      // 4. ATS Not Detected - Add to discovery queue tracker
      await this.db.query(
        `INSERT INTO discovery_queue_jobs (domain, company_name, status)
         VALUES ($1, $2, 'queued')
         ON CONFLICT (domain) 
         DO UPDATE SET status = 'queued', updated_at = CURRENT_TIMESTAMP`,
        [resolution.domain, companyName]
      );

      // 5. Add BullMQ job to run Playwright + LLM
      await this.discoveryQueue.add('discover-ats', {
        userId,
        companyName,
        url: url.trim(),
        domain: resolution.domain,
        locationFilter,
        roleFilter
      });

      return {
        status: 'queued',
        message: 'Company unsupported. Discovery queued. Will be available in 5 minutes.',
      };
    }
  }

  /**
   * Synchronizes jobs for a specific company by querying its provider
   */
  async syncJobsForCompany(companyId: number): Promise<void> {
    const companyRes = await this.db.query(
      `SELECT * FROM watched_companies WHERE id = $1`,
      [companyId]
    );

    if (companyRes.rows.length === 0) return;
    const company = companyRes.rows[0];

    this.logger.log(`Syncing jobs for company: ${company.name}`);

    // Retrieve all active watchers and their filters for this company
    const watchersRes = await this.db.query(
      `SELECT DISTINCT user_id, location_filter, role_filter FROM job_watchers WHERE company_id = $1`,
      [companyId]
    );
    const watchers = watchersRes.rows;

    if (watchers.length === 0) {
      this.logger.log(`No active watchers for ${company.name}. Skipping sync.`);
      return;
    }

    const jobsToProcess: { job: RawJob; matchingWatchers: any[] }[] = [];

    const hasPlaceholders = (cfg: any): boolean => {
      const str = JSON.stringify(cfg);
      return str.includes('{{role}}') || str.includes('{{location}}');
    };

    if (company.provider_type.toLowerCase() === 'custom' && hasPlaceholders(company.config)) {
      // Group watchers by distinct role & location filter combinations
      const groups = new Map<string, { role: string; location: string; watchers: any[] }>();
      for (const watcher of watchers) {
        const role = watcher.role_filter || '';
        const location = watcher.location_filter || '';
        const key = `${role.toLowerCase()}|${location.toLowerCase()}`;
        if (!groups.has(key)) {
          groups.set(key, { role, location, watchers: [] });
        }
        groups.get(key)!.watchers.push(watcher);
      }

      this.logger.log(`Syncing custom provider with templates for ${company.name} in ${groups.size} filter groups.`);

      for (const [key, group] of groups.entries()) {
        try {
          let configStr = JSON.stringify(company.config);
          configStr = configStr
            .replace(/\{\{role\}\}/g, group.role)
            .replace(/\{\{location\}\}/g, group.location);
          const interpolatedConfig = JSON.parse(configStr);

          const groupJobs = await this.customConfig.fetchJobsWithConfig(company.name, interpolatedConfig);
          this.logger.log(`Fetched ${groupJobs.length} jobs for group "${key}"`);

          for (const job of groupJobs) {
            // Guarantee matching using local filters
            const matchingWatchers = group.watchers.filter(watcher =>
              this.matchesFilters(job, watcher.location_filter, watcher.role_filter)
            );
            if (matchingWatchers.length > 0) {
              jobsToProcess.push({ job, matchingWatchers });
            }
          }
        } catch (err) {
          this.logger.error(`Failed custom sync for group "${key}": ${err.message}`);
        }
      }
    } else {
      // Standard flow (fetch all once and filter locally)
      let rawJobs: RawJob[] = [];
      switch (company.provider_type.toLowerCase()) {
        case 'greenhouse':
          rawJobs = await this.greenhouse.fetchJobs(company.provider_slug);
          break;
        case 'lever':
          rawJobs = await this.lever.fetchJobs(company.provider_slug);
          break;
        case 'ashby':
          rawJobs = await this.ashby.fetchJobs(company.provider_slug);
          break;
        case 'workday':
          rawJobs = await this.workday.fetchJobs(company.provider_slug);
          break;
        case 'icims':
          rawJobs = await this.icims.fetchJobs(company.provider_slug);
          break;
        case 'custom':
          rawJobs = await this.customConfig.fetchJobsWithConfig(company.name, company.config);
          break;
        default:
          this.logger.error(`Unsupported provider type: ${company.provider_type}`);
          return;
      }

      for (const job of rawJobs) {
        const matchingWatchers = watchers.filter(watcher =>
          this.matchesFilters(job, watcher.location_filter, watcher.role_filter)
        );
        if (matchingWatchers.length > 0) {
          jobsToProcess.push({ job, matchingWatchers });
        }
      }
    }

    // Insert new jobs and check if they are newly discovered
    let newJobsCount = 0;
    for (const { job, matchingWatchers } of jobsToProcess) {
      // Deduplicate using a unique hash of (company_id, external_id)
      const jobHash = `${companyId}|${job.externalId}`;
      let savedForAny = false;

      for (const watcher of matchingWatchers) {
        const insertRes = await this.db.query(
          `INSERT INTO results (user_id, job_id, company, title, location, source, url, score, reasoning, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT (user_id, job_id) DO NOTHING
           RETURNING id`,
          [
            watcher.user_id,
            jobHash,
            company.name,
            job.title,
            job.location,
            company.provider_type,
            job.applyUrl,
            100,
            `Dream Job Watch alert: matched "${watcher.role_filter || 'Any role'}" in "${watcher.location_filter || 'Any location'}"`,
            'matched'
          ]
        );

        if ((insertRes.rowCount ?? 0) > 0) {
          savedForAny = true;
          // Notify this specific matching user
          await this.notifyWatcher(watcher.user_id, job);
        }
      }

      if (savedForAny) {
        newJobsCount++;
      }
    }

    this.logger.log(`Sync completed for ${company.name}. Discovered ${newJobsCount} filtered new jobs.`);
  }

  /**
   * Triggers a sync run for all active companies
   */
  async syncAllActiveCompanies(): Promise<void> {
    const res = await this.db.query(
      `SELECT id FROM watched_companies WHERE status = 'active'`
    );

    this.logger.log(`Running bulk watch synchronization for ${res.rows.length} companies...`);
    for (const row of res.rows) {
      try {
        await this.syncJobsForCompany(row.id);
      } catch (err) {
        this.logger.error(`Failed bulk sync for company ID ${row.id}: ${err.message}`);
      }
    }
  }

  /**
   * Approves a staging discovery config and promotes it to active watched status
   */
  async approveDiscovery(
    discoveryId: number,
    customConfig: any
  ): Promise<boolean> {
    const res = await this.db.query(
      `SELECT * FROM discovery_queue_jobs WHERE id = $1`,
      [discoveryId]
    );

    if (res.rows.length === 0) return false;
    const discovery = res.rows[0];

    // Promote to watched_companies as a 'custom' provider type
    const compRes = await this.db.query(
      `INSERT INTO watched_companies (name, domain, provider_type, provider_slug, config, status)
       VALUES ($1, $2, 'custom', 'custom', $3, 'active')
       ON CONFLICT (name) 
       DO UPDATE SET provider_type = 'custom', config = EXCLUDED.config, status = 'active'
       RETURNING id`,
      [discovery.company_name, discovery.domain, customConfig]
    );

    // Update discovery queue status
    await this.db.query(
      `UPDATE discovery_queue_jobs 
       SET status = 'approved', updated_at = CURRENT_TIMESTAMP 
       WHERE id = $1`,
      [discoveryId]
    );

    const companyId = compRes.rows[0].id;

    // Trigger immediate sync
    this.syncJobsForCompany(companyId).catch((err) =>
      this.logger.error(`Error in immediate job sync after approval for company ${companyId}: ${err.message}`)
    );

    return true;
  }

  /**
   * Helper to alert all subscribed users via Telegram
   */
  /**
   * Checks if a job matches user-defined location and role filters
   */
  private matchesFilters(job: RawJob, locationFilter?: string, roleFilter?: string): boolean {
    if (roleFilter && roleFilter.trim()) {
      const rf = roleFilter.trim().toLowerCase();
      const title = (job.title || '').toLowerCase();
      if (!title.includes(rf)) {
        return false;
      }
    }

    if (locationFilter && locationFilter.trim()) {
      const lf = locationFilter.trim().toLowerCase();
      const loc = (job.location || '').toLowerCase();
      if (!loc.includes(lf)) {
        return false;
      }
    }

    return true;
  }

  /**
   * Helper to alert a specific subscribed user via Telegram
   */
  private async notifyWatcher(userId: number, job: RawJob): Promise<void> {
    const userRes = await this.db.query(
      `SELECT email FROM users WHERE id = $1`,
      [userId]
    );

    if (userRes.rows.length === 0) return;
    const userEmail = userRes.rows[0].email;

    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;

    if (!botToken || !chatId) {
      this.logger.warn(`Telegram credentials not found. Cannot send watcher notification.`);
      return;
    }

    const message = `🚨 <b>Dream Company Job Alert!</b> 🚨\n\n` +
      `🏢 <b>Company:</b> ${job.company.toUpperCase()}\n` +
      `💼 <b>Role:</b> ${job.title}\n` +
      `📍 <b>Location:</b> ${job.location}\n\n` +
      `🔗 <a href="${job.applyUrl}">Apply Directly Here</a>`;

    try {
      const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: message,
          parse_mode: 'HTML',
        }),
      });

      if (!response.ok) {
        throw new Error(`Telegram sent back status ${response.status}`);
      }
    } catch (e) {
      this.logger.error(`Failed to send watcher Telegram alert to ${userEmail}: ${e.message}`);
    }
  }

  /**
   * Lists active watchers
   */
  async getWatchersForUser(userEmail: string | undefined) {
    const email = (userEmail || 'default@example.com').trim().toLowerCase();
    
    // Resolve user ID
    const userRes = await this.db.query(
      `SELECT id FROM users WHERE LOWER(email) = LOWER($1)`,
      [email]
    );
    if (userRes.rows.length === 0) return [];
    const userId = userRes.rows[0].id;

    const res = await this.db.query(
      `SELECT c.id, c.name, c.domain, c.provider_type, c.status, w.created_at, w.location_filter, w.role_filter
       FROM job_watchers w
       JOIN watched_companies c ON w.company_id = c.id
       WHERE w.user_id = $1`,
      [userId]
    );
    return res.rows;
  }

  /**
   * Lists discovery queue
   */
  async getDiscoveryQueue() {
    const res = await this.db.query(
      `SELECT * FROM discovery_queue_jobs ORDER BY created_at DESC`
    );
    return res.rows;
  }
}
