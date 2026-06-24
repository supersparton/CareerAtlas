import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../vector-store/database.service';
import { WatcherAnalysisService, DiscoveryMetadataInput } from './watcher-analysis.service';

export interface WatchlistPreferences {
  desiredRoles: string[];
  preferredLocations: string[];
  keywords: string[];
  notificationFrequency: string;
}

@Injectable()
export class WatcherService {
  private readonly logger = new Logger(WatcherService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly analysisService: WatcherAnalysisService
  ) {}

  // Register or retrieve a company in the registry
  async getOrCreateCompany(companyIdentifier: string, companyName: string, careersUrl: string) {
    const ident = companyIdentifier.toLowerCase().trim();
    // Check if exists
    const existing = await this.db.query(
      'SELECT * FROM scraper_templates WHERE company_identifier = $1',
      [ident]
    );

    if (existing.rows.length > 0) {
      return existing.rows[0];
    }

    // Insert new with initial status of 'Pending Discovery'
    const result = await this.db.query(
      `INSERT INTO scraper_templates 
       (company_identifier, company_name, careers_url, monitoring_status)
       VALUES ($1, $2, $3, 'Pending Discovery')
       RETURNING *`,
      [ident, companyName, careersUrl]
    );

    const newCompany = result.rows[0];

    // Trigger automatic discovery in background
    this.discoverAndApplyEndpoint(newCompany.id, ident, companyName, careersUrl).catch(err => {
      this.logger.error(`Error in automatic discovery background job: ${err.message}`);
    });

    return newCompany;
  }

  // Get all companies in registry
  async getAllCompanies() {
    const res = await this.db.query('SELECT * FROM scraper_templates ORDER BY company_name ASC');
    return res.rows;
  }

  // Get active scraper configs
  async getActiveScraperConfigs() {
    const res = await this.db.query(
      `SELECT * FROM scraper_templates 
       WHERE monitoring_status IN ('Public API', 'GraphQL Endpoint', 'Static HTML Page')`
    );
    return res.rows;
  }

  // Update scraper template config
  async updateScraperConfig(
    companyId: number,
    config: {
      endpointUrl?: string;
      httpMethod?: string;
      headers?: Record<string, string>;
      bodyTemplate?: string;
      extractionStrategy?: string;
      pollingInterval?: number;
      monitoringStatus?: string;
    }
  ) {
    const { endpointUrl, httpMethod, headers, bodyTemplate, extractionStrategy, pollingInterval, monitoringStatus } = config;
    
    await this.db.query(
      `UPDATE scraper_templates
       SET endpoint_url = COALESCE($1, endpoint_url),
           http_method = COALESCE($2, http_method),
           headers = COALESCE($3::jsonb, headers),
           body_template = COALESCE($4, body_template),
           extraction_strategy = COALESCE($5, extraction_strategy),
           polling_interval = COALESCE($6, polling_interval),
           monitoring_status = COALESCE($7, monitoring_status),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $8`,
      [
        endpointUrl || null,
        httpMethod || null,
        headers ? JSON.stringify(headers) : null,
        bodyTemplate || null,
        extractionStrategy || null,
        pollingInterval || null,
        monitoringStatus || null,
        companyId
      ]
    );
  }

  // Log discovery metadata and run backend analysis
  async processDiscoveryMetadata(input: DiscoveryMetadataInput) {
    // 1. Analyze request
    const analysis = await this.analysisService.analyzeRequest(input);

    // 2. Log in database
    await this.db.query(
      `INSERT INTO discovery_metadata
       (company_identifier, careers_url, request_url, method, headers, payload, response_body, content_type, confidence_score, classification, is_monitored_server_side)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11)`,
      [
        input.companyIdentifier.toLowerCase().trim(),
        input.careersUrl,
        input.requestUrl,
        input.method,
        JSON.stringify(input.headers),
        input.payload || null,
        input.responseBody || null,
        input.contentType || null,
        analysis.confidenceScore,
        analysis.classification,
        analysis.isMonitoredServerSide
      ]
    );

    // 3. If analyzed request is suitable for server-side monitoring, update/create the scraper template!
    if (analysis.isMonitoredServerSide) {
      const company = await this.getOrCreateCompany(
        input.companyIdentifier,
        input.companyName,
        input.careersUrl
      );

      // Guess extraction strategy
      let extractionStrategy = 'json';
      if (analysis.classification === 'Static HTML Page') {
        extractionStrategy = 'html';
      }

      await this.updateScraperConfig(company.id, {
        endpointUrl: input.requestUrl,
        httpMethod: input.method,
        headers: input.headers,
        bodyTemplate: input.payload,
        extractionStrategy,
        monitoringStatus: analysis.classification
      });
      
      this.logger.log(`[WATCHER-SERVICE] Updated scraper template for ${input.companyName} based on discovery.`);
    }

    return {
      success: true,
      analysis
    };
  }

  // Add a company to a user's watchlist
  async addToWatchlist(
    userEmail: string,
    companyIdentifier: string,
    companyName: string,
    careersUrl: string,
    prefs: WatchlistPreferences
  ) {
    // 1. Get or create user
    let userRes = await this.db.query('SELECT id FROM users WHERE email = $1', [userEmail]);
    let userId: number;
    if (userRes.rows.length === 0) {
      const newUser = await this.db.query(
        'INSERT INTO users (full_name, email) VALUES ($1, $2) RETURNING id',
        [companyName + ' Watcher User', userEmail]
      );
      userId = newUser.rows[0].id;
    } else {
      userId = userRes.rows[0].id;
    }

    // 2. Get or create company
    const company = await this.getOrCreateCompany(companyIdentifier, companyName, careersUrl);

    // 3. Add to user_watchlists (upsert)
    await this.db.query(
      `INSERT INTO user_watchlists
       (user_id, company_id, desired_roles, preferred_locations, keywords, notification_frequency)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id, company_id) DO UPDATE
       SET desired_roles = EXCLUDED.desired_roles,
           preferred_locations = EXCLUDED.preferred_locations,
           keywords = EXCLUDED.keywords,
           notification_frequency = EXCLUDED.notification_frequency,
           updated_at = CURRENT_TIMESTAMP`,
      [
        userId,
        company.id,
        prefs.desiredRoles,
        prefs.preferredLocations,
        prefs.keywords,
        prefs.notificationFrequency || 'realtime'
      ]
    );

    return {
      success: true,
      companyId: company.id,
      userId
    };
  }

  // Get a user's watchlist
  async getUserWatchlist(userEmail: string) {
    const res = await this.db.query(
      `SELECT uw.*, st.company_name, st.company_identifier, st.careers_url, st.monitoring_status, st.endpoint_url
       FROM user_watchlists uw
       JOIN scraper_templates st ON uw.company_id = st.id
       JOIN users u ON uw.user_id = u.id
       WHERE u.email = $1`,
      [userEmail]
    );
    return res.rows;
  }

  // Remove a company from user's watchlist
  async removeFromWatchlist(userEmail: string, companyId: number) {
    await this.db.query(
      `DELETE FROM user_watchlists
       WHERE company_id = $1 AND user_id = (SELECT id FROM users WHERE email = $2)`,
      [companyId, userEmail]
    );
    return { success: true };
  }

  // Get watchlists for a specific company (used during matching)
  async getWatchlistsForCompany(companyId: number) {
    const res = await this.db.query(
      `SELECT uw.*, u.email
       FROM user_watchlists uw
       JOIN users u ON uw.user_id = u.id
       WHERE uw.company_id = $1`,
      [companyId]
    );
    return res.rows;
  }

  // Get previously seen jobs for a company to detect updates/new postings
  async getMonitoredJobsForCompany(companyId: number): Promise<Map<string, string>> {
    const res = await this.db.query(
      'SELECT job_external_id, payload_hash FROM monitored_jobs WHERE company_id = $1',
      [companyId]
    );
    const map = new Map<string, string>();
    for (const row of res.rows) {
      map.set(row.job_external_id, row.payload_hash);
    }
    return map;
  }

  // Return captured network intercepts from discovery_metadata (real extension captures)
  async getDiscoveredEndpoints(companyIdentifier?: string) {
    if (companyIdentifier) {
      const res = await this.db.query(
        `SELECT * FROM discovery_metadata
         WHERE company_identifier = $1
         ORDER BY created_at DESC LIMIT 50`,
        [companyIdentifier.toLowerCase().trim()]
      );
      return res.rows;
    }
    const res = await this.db.query(
      `SELECT * FROM discovery_metadata ORDER BY created_at DESC LIMIT 100`
    );
    return res.rows;
  }

  // Save/Update monitored job records
  async saveMonitoredJob(companyId: number, jobId: string, title: string, location: string, url: string, hash: string) {
    await this.db.query(
      `INSERT INTO monitored_jobs (company_id, job_external_id, title, location, url, payload_hash)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (company_id, job_external_id) DO UPDATE
       SET title = EXCLUDED.title,
           location = EXCLUDED.location,
           url = EXCLUDED.url,
           payload_hash = EXCLUDED.payload_hash`,
      [companyId, jobId, title, location, url, hash]
    );
  }

  // Automatic endpoint discovery fallback routines
  async discoverAndApplyEndpoint(companyId: number, companyIdentifier: string, companyName: string, careersUrl: string) {
    this.logger.log(`[Discovery] Starting automatic endpoint discovery for ${companyName} (${companyIdentifier}) at ${careersUrl}`);
    
    // 1. Try checking common ATS platforms (Greenhouse, Lever, SmartRecruiters) using slug fallback
    const candidates = [
      {
        url: `https://boards-api.greenhouse.io/v1/boards/${companyIdentifier}/jobs`,
        classification: 'Public API',
        strategy: 'json'
      },
      {
        url: `https://api.lever.co/v0/postings/${companyIdentifier}`,
        classification: 'Public API',
        strategy: 'json'
      },
      {
        url: `https://api.smartrecruiters.com/v1/companies/${companyIdentifier}/postings`,
        classification: 'Public API',
        strategy: 'json'
      }
    ];

    for (const cand of candidates) {
      try {
        const res = await fetch(cand.url, { method: 'GET', signal: AbortSignal.timeout(3000) });
        if (res.ok) {
          const body = await res.text();
          try {
            const parsed = JSON.parse(body);
            if (parsed && (Array.isArray(parsed) || (parsed.jobs && Array.isArray(parsed.jobs)) || Array.isArray(parsed.postings))) {
              this.logger.log(`[Discovery] Found active ${cand.classification} endpoint via identifier fallback: ${cand.url}`);
              await this.updateScraperConfig(companyId, {
                endpointUrl: cand.url,
                httpMethod: 'GET',
                headers: { 'Accept': 'application/json' },
                extractionStrategy: cand.strategy,
                monitoringStatus: cand.classification
              });
              return;
            }
          } catch {}
        }
      } catch {}
    }

    // 2. If fallbacks fail, retrieve careersUrl page and parse raw HTML content for patterns
    try {
      const res = await fetch(careersUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
        },
        signal: AbortSignal.timeout(5000)
      });

      if (res.ok) {
        const html = await res.text();

        // Greenhouse pattern
        const greenhouseMatch = html.match(/boards\.greenhouse\.io\/([^/\"\'\>\s\?\#]+)/i);
        if (greenhouseMatch && greenhouseMatch[1]) {
          const token = greenhouseMatch[1].trim();
          const targetUrl = `https://boards-api.greenhouse.io/v1/boards/${token}/jobs`;
          const verify = await fetch(targetUrl, { signal: AbortSignal.timeout(3000) });
          if (verify.ok) {
            this.logger.log(`[Discovery] Found active Greenhouse board from HTML: ${token} at ${targetUrl}`);
            await this.updateScraperConfig(companyId, {
              endpointUrl: targetUrl,
              httpMethod: 'GET',
              headers: { 'Accept': 'application/json' },
              extractionStrategy: 'json',
              monitoringStatus: 'Public API'
            });
            return;
          }
        }

        // Lever pattern
        const leverMatch = html.match(/jobs\.lever\.co\/([^/\"\'\>\s\?\#]+)/i) || html.match(/api\.lever\.co\/v0\/postings\/([^/\"\'\>\s\?\#]+)/i);
        if (leverMatch && leverMatch[1]) {
          const token = leverMatch[1].trim();
          const targetUrl = `https://api.lever.co/v0/postings/${token}`;
          const verify = await fetch(targetUrl, { signal: AbortSignal.timeout(3000) });
          if (verify.ok) {
            this.logger.log(`[Discovery] Found active Lever board from HTML: ${token} at ${targetUrl}`);
            await this.updateScraperConfig(companyId, {
              endpointUrl: targetUrl,
              httpMethod: 'GET',
              headers: { 'Accept': 'application/json' },
              extractionStrategy: 'json',
              monitoringStatus: 'Public API'
            });
            return;
          }
        }

        // SmartRecruiters pattern
        const smartMatch = html.match(/smartrecruiters\.com\/([^/\"\'\>\s\?\#]+)/i);
        if (smartMatch && smartMatch[1] && smartMatch[1] !== 'sr-careers-frontend') {
          const token = smartMatch[1].trim();
          const targetUrl = `https://api.smartrecruiters.com/v1/companies/${token}/postings`;
          const verify = await fetch(targetUrl, { signal: AbortSignal.timeout(3000) });
          if (verify.ok) {
            this.logger.log(`[Discovery] Found active SmartRecruiters board from HTML: ${token} at ${targetUrl}`);
            await this.updateScraperConfig(companyId, {
              endpointUrl: targetUrl,
              httpMethod: 'GET',
              headers: { 'Accept': 'application/json' },
              extractionStrategy: 'json',
              monitoringStatus: 'Public API'
            });
            return;
          }
        }
      }
    } catch (err) {
      this.logger.error(`Error parsing HTML during endpoint discovery: ${err.message}`);
    }

    this.logger.log(`[Discovery] Automatic discovery completed. No public endpoints identified. Awaiting user-guided browser capture.`);
  }

  // Real-time endpoint discovery scan triggered from the frontend simulator
  async discoverRealEndpoint(companyId: number, companyIdentifier: string, companyName: string, careersUrl: string) {
    this.logger.log(`[Real Discovery] Starting real-time API endpoint discovery for ${companyName} (${companyIdentifier})`);
    
    // 1. Try fallbacks using the company identifier directly (Greenhouse, Lever, SmartRecruiters)
    const candidates = [
      {
        url: `https://boards-api.greenhouse.io/v1/boards/${companyIdentifier}/jobs`,
        classification: 'Public API',
        strategy: 'json',
        provider: 'Greenhouse'
      },
      {
        url: `https://api.lever.co/v0/postings/${companyIdentifier}`,
        classification: 'Public API',
        strategy: 'json',
        provider: 'Lever'
      },
      {
        url: `https://api.smartrecruiters.com/v1/companies/${companyIdentifier}/postings`,
        classification: 'Public API',
        strategy: 'json',
        provider: 'SmartRecruiters'
      }
    ];

    for (const cand of candidates) {
      try {
        const res = await fetch(cand.url, { method: 'GET', signal: AbortSignal.timeout(3000) });
        if (res.ok) {
          const body = await res.text();
          try {
            const parsed = JSON.parse(body);
            if (parsed && (Array.isArray(parsed) || (parsed.jobs && Array.isArray(parsed.jobs)) || Array.isArray(parsed.postings))) {
              await this.updateScraperConfig(companyId, {
                endpointUrl: cand.url,
                httpMethod: 'GET',
                headers: { 'Accept': 'application/json' },
                extractionStrategy: cand.strategy,
                monitoringStatus: cand.classification
              });
              return { success: true, endpointUrl: cand.url, provider: cand.provider, method: 'GET' };
            }
          } catch {}
        }
      } catch {}
    }

    // 2. Fetch the careers HTML page and parse it
    try {
      const res = await fetch(careersUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
        },
        signal: AbortSignal.timeout(5000)
      });

      if (res.ok) {
        const html = await res.text();

        // Greenhouse pattern
        const greenhouseMatch = html.match(/boards\.greenhouse\.io\/([^/\"\'\>\s\?\#]+)/i);
        if (greenhouseMatch && greenhouseMatch[1]) {
          const token = greenhouseMatch[1].trim();
          const targetUrl = `https://boards-api.greenhouse.io/v1/boards/${token}/jobs`;
          const verify = await fetch(targetUrl, { signal: AbortSignal.timeout(3000) });
          if (verify.ok) {
            await this.updateScraperConfig(companyId, {
              endpointUrl: targetUrl,
              httpMethod: 'GET',
              headers: { 'Accept': 'application/json' },
              extractionStrategy: 'json',
              monitoringStatus: 'Public API'
            });
            return { success: true, endpointUrl: targetUrl, provider: 'Greenhouse', method: 'GET' };
          }
        }

        // Lever pattern
        const leverMatch = html.match(/jobs\.lever\.co\/([^/\"\'\>\s\?\#]+)/i) || html.match(/api\.lever\.co\/v0\/postings\/([^/\"\'\>\s\?\#]+)/i);
        if (leverMatch && leverMatch[1]) {
          const token = leverMatch[1].trim();
          const targetUrl = `https://api.lever.co/v0/postings/${token}`;
          const verify = await fetch(targetUrl, { signal: AbortSignal.timeout(3000) });
          if (verify.ok) {
            await this.updateScraperConfig(companyId, {
              endpointUrl: targetUrl,
              httpMethod: 'GET',
              headers: { 'Accept': 'application/json' },
              extractionStrategy: 'json',
              monitoringStatus: 'Public API'
            });
            return { success: true, endpointUrl: targetUrl, provider: 'Lever', method: 'GET' };
          }
        }

        // SmartRecruiters pattern
        const smartMatch = html.match(/smartrecruiters\.com\/([^/\"\'\>\s\?\#]+)/i);
        if (smartMatch && smartMatch[1] && smartMatch[1] !== 'sr-careers-frontend') {
          const token = smartMatch[1].trim();
          const targetUrl = `https://api.smartrecruiters.com/v1/companies/${token}/postings`;
          const verify = await fetch(targetUrl, { signal: AbortSignal.timeout(3000) });
          if (verify.ok) {
            await this.updateScraperConfig(companyId, {
              endpointUrl: targetUrl,
              httpMethod: 'GET',
              headers: { 'Accept': 'application/json' },
              extractionStrategy: 'json',
              monitoringStatus: 'Public API'
            });
            return { success: true, endpointUrl: targetUrl, provider: 'SmartRecruiters', method: 'GET' };
          }
        }
      }
    } catch (err) {
      this.logger.error(`Error parsing HTML during endpoint discovery: ${err.message}`);
    }

    return { success: false, message: 'Could not automatically identify any public API or jobs feed endpoints.' };
  }
}
