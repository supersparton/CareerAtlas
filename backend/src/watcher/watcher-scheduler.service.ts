import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { WatcherService } from './watcher.service';
import { NotificationDispatcher } from './notifications/notification.dispatcher';
import * as crypto from 'crypto';

@Injectable()
export class WatcherSchedulerService implements OnModuleInit {
  private readonly logger = new Logger(WatcherSchedulerService.name);
  private checkInterval: NodeJS.Timeout;

  constructor(
    private readonly watcherService: WatcherService,
    private readonly notificationDispatcher: NotificationDispatcher
  ) {}

  onModuleInit() {
    this.logger.log('[WATCHER-SCHEDULER] Initializing background watcher loop...');
    // Run monitoring every 30 minutes in development/local mode
    this.checkInterval = setInterval(async () => {
      try {
        await this.runAllChecks();
      } catch (err) {
        this.logger.error(`[WATCHER-SCHEDULER] Periodic monitoring run failed: ${err.message}`);
      }
    }, 30 * 60 * 1000);
  }

  // Allow triggering checks manually via API
  async runAllChecks() {
    this.logger.log('[WATCHER-SCHEDULER] Starting monitoring check cycle...');
    const activeConfigs = await this.watcherService.getActiveScraperConfigs();
    this.logger.log(`[WATCHER-SCHEDULER] Found ${activeConfigs.length} active monitoring configurations.`);

    for (const config of activeConfigs) {
      try {
        await this.checkCompanyJobs(config);
      } catch (err) {
        this.logger.error(`[WATCHER-SCHEDULER] Failed checking jobs for ${config.company_name}: ${err.message}`);
        // Fallback strategy: update status to require advanced scraping if it keeps failing
        await this.watcherService.updateScraperConfig(config.id, {
          monitoringStatus: 'Advanced Scraping Required'
        });
        this.logger.warn(`[WATCHER-SCHEDULER] Marked ${config.company_name} as requiring advanced scraping.`);
      }
    }
    this.logger.log('[WATCHER-SCHEDULER] Completed monitoring check cycle.');
  }

  async checkCompanyJobs(config: any) {
    this.logger.log(`[WATCHER-SCHEDULER] Fetching job feed for ${config.company_name} from: ${config.endpoint_url}`);

    const method = (config.http_method || 'GET').toUpperCase();
    const headers = typeof config.headers === 'string' ? JSON.parse(config.headers) : (config.headers || {});
    const body = config.body_template || undefined;

    const response = await fetch(config.endpoint_url, {
      method,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        ...headers
      },
      body: body ? body : undefined,
      signal: AbortSignal.timeout(10000) // 10s timeout
    });

    if (!response.ok) {
      throw new Error(`Endpoint returned status ${response.status}: ${response.statusText}`);
    }

    const text = await response.text();
    let jobs: any[] = [];

    if (config.extraction_strategy === 'json') {
      let json: any;
      try {
        json = JSON.parse(text);
      } catch (e) {
        throw new Error(`Failed to parse response as JSON even though strategy is 'json'`);
      }

      jobs = this.extractJobsFromJson(json, config);
    } else if (config.extraction_strategy === 'html') {
      jobs = this.extractJobsFromHtml(text, config);
    } else {
      throw new Error(`Unsupported extraction strategy: ${config.extraction_strategy}`);
    }

    this.logger.log(`[WATCHER-SCHEDULER] Extracted ${jobs.length} raw jobs for ${config.company_name}`);

    // Diff against previously seen jobs
    const previousJobsMap = await this.watcherService.getMonitoredJobsForCompany(config.id);
    const watchlists = await this.watcherService.getWatchlistsForCompany(config.id);

    for (const job of jobs) {
      const stableHash = crypto.createHash('sha256').update(JSON.stringify(job)).digest('hex');
      const previouslySeenHash = previousJobsMap.get(job.id);

      if (!previouslySeenHash) {
        // This is a brand new job!
        this.logger.log(`[WATCHER-SCHEDULER] New job detected: "${job.title}" at ${config.company_name} (${job.location})`);
        
        // Save to DB so we don't notify again
        await this.watcherService.saveMonitoredJob(
          config.id,
          job.id,
          job.title,
          job.location,
          job.url,
          stableHash
        );

        // Run matching logic for each interested user
        for (const watch of watchlists) {
          const isMatched = this.matchJob(job, watch);
          if (isMatched.matched) {
            await this.notificationDispatcher.dispatch(watch.user_id, watch.email, {
              jobTitle: job.title,
              companyName: config.company_name,
              location: job.location,
              url: job.url,
              matchedRole: isMatched.matchedRole,
              matchedLocation: isMatched.matchedLocation,
              matchedKeywords: isMatched.matchedKeywords
            });
          }
        }
      } else if (previouslySeenHash !== stableHash) {
        // Job was updated
        this.logger.log(`[WATCHER-SCHEDULER] Updated job details detected: "${job.title}" at ${config.company_name}`);
        await this.watcherService.saveMonitoredJob(
          config.id,
          job.id,
          job.title,
          job.location,
          job.url,
          stableHash
        );
      }
    }
  }

  private matchJob(job: { title: string; location: string }, watchlist: any): { matched: boolean; matchedRole?: string; matchedLocation?: string; matchedKeywords?: string[] } {
    const title = job.title.toLowerCase();
    const location = job.location.toLowerCase();

    // 1. Role matching (case-insensitive substring)
    let matchedRole: string | undefined;
    const roles: string[] = watchlist.desired_roles || [];
    if (roles.length > 0) {
      const matched = roles.find(r => title.includes(r.toLowerCase()));
      if (!matched) return { matched: false };
      matchedRole = matched;
    }

    // 2. Location matching (case-insensitive substring)
    let matchedLocation: string | undefined;
    const locations: string[] = watchlist.preferred_locations || [];
    if (locations.length > 0) {
      const matched = locations.find(l => location.includes(l.toLowerCase()));
      if (!matched) return { matched: false };
      matchedLocation = matched;
    }

    // 3. Keywords matching (case-insensitive substring)
    const matchedKeywords: string[] = [];
    const keywords: string[] = watchlist.keywords || [];
    if (keywords.length > 0) {
      const matched = keywords.filter(k => 
        title.includes(k.toLowerCase()) || location.includes(k.toLowerCase())
      );
      if (matched.length === 0) return { matched: false };
      matchedKeywords.push(...matched);
    }

    return {
      matched: true,
      matchedRole,
      matchedLocation,
      matchedKeywords
    };
  }

  private extractJobsFromJson(json: any, config: any): any[] {
    const rawArray = this.findLargestArray(json);
    if (!rawArray) return [];

    const jobs: any[] = [];

    for (const item of rawArray) {
      if (!item || typeof item !== 'object') continue;

      // Extract details using key heuristics
      const id = String(item.id || item.jobId || item.postingId || item.requisitionId || item.reqId || this.generateFallbackId(item));
      const title = String(item.title || item.name || item.role || 'Unknown Job Title');
      
      let location = 'Unknown';
      if (item.location) {
        if (typeof item.location === 'string') {
          location = item.location;
        } else if (typeof item.location === 'object') {
          location = item.location.name || item.location.city || JSON.stringify(item.location);
        }
      } else if (item.office) {
        location = typeof item.office === 'string' ? item.office : (item.office.name || 'Unknown');
      }

      let url = config.careers_url;
      const urlCandidate = item.url || item.link || item.applyUrl || item.absolute_url;
      if (urlCandidate && typeof urlCandidate === 'string') {
        if (urlCandidate.startsWith('http')) {
          url = urlCandidate;
        } else {
          // Construct URL using base domain
          try {
            const parsedBase = new URL(config.careers_url);
            url = `${parsedBase.protocol}//${parsedBase.host}${urlCandidate.startsWith('/') ? '' : '/'}${urlCandidate}`;
          } catch (e) {
            url = urlCandidate;
          }
        }
      }

      jobs.push({ id, title, location, url });
    }

    return jobs;
  }

  private extractJobsFromHtml(html: string, config: any): any[] {
    // Regex based simple HTML link scraper as a fallback strategy
    const jobs: any[] = [];
    const linkRegex = /<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]+?)<\/a>/gi;
    let match;
    let index = 1;

    while ((match = linkRegex.exec(html)) !== null) {
      const urlCandidate = match[1];
      const linkText = match[2].replace(/<[^>]*>/g, '').trim();

      // Look for job indicator links
      if (
        (urlCandidate.includes('/jobs/') || urlCandidate.includes('/careers/') || urlCandidate.includes('/posting/')) &&
        linkText.length > 5 &&
        linkText.length < 100
      ) {
        let url = urlCandidate;
        if (!urlCandidate.startsWith('http')) {
          try {
            const parsedBase = new URL(config.careers_url);
            url = `${parsedBase.protocol}//${parsedBase.host}${urlCandidate.startsWith('/') ? '' : '/'}${urlCandidate}`;
          } catch (e) {
            url = urlCandidate;
          }
        }

        jobs.push({
          id: `html_${index++}`,
          title: linkText,
          location: 'Remote / See Details',
          url
        });
      }
    }

    return jobs;
  }

  private findLargestArray(obj: any): any[] | null {
    if (Array.isArray(obj)) return obj;
    if (obj && typeof obj === 'object') {
      let largest: any[] | null = null;
      for (const key of Object.keys(obj)) {
        const val = obj[key];
        if (Array.isArray(val)) {
          if (!largest || val.length > largest.length) {
            largest = val;
          }
        } else if (typeof val === 'object') {
          const sub = this.findLargestArray(val);
          if (sub && (!largest || sub.length > largest.length)) {
            largest = sub;
          }
        }
      }
      return largest;
    }
    return null;
  }

  private generateFallbackId(item: any): string {
    const data = JSON.stringify(item);
    return crypto.createHash('sha256').update(data).digest('hex').substring(0, 12);
  }
}
