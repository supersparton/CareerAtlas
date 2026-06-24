// Cloudflare Worker: Scheduled Cron Trigger for Dream Company Watcher
// This worker runs independently from user devices to fetch, normalize, diff, and match job openings.

export interface Env {
  // Backend API URL (e.g. https://your-career-os-api.com)
  BACKEND_API_URL: string;
  // Shared API Secret to authenticate worker calls to backend
  WORKER_API_SECRET: string;
}

export default {
  async scheduled(event: any, env: Env, ctx: any): Promise<void> {
    ctx.waitUntil(this.runMonitoring(env));
  },

  // Also support manual triggering via HTTP fetch
  async fetch(request: Request, env: Env, ctx: any): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/run') {
      ctx.waitUntil(this.runMonitoring(env));
      return new Response(JSON.stringify({ message: 'Monitoring run started.' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('Dream Company Watcher Cloudflare Worker is active.', { status: 200 });
  },

  async runMonitoring(env: Env): Promise<void> {
    console.log('[Worker] Starting periodic watcher run...');

    try {
      // 1. Fetch active company configurations from backend API
      const configsRes = await fetch(`${env.BACKEND_API_URL}/api/watcher/companies`, {
        headers: {
          'Authorization': `Bearer ${env.WORKER_API_SECRET}`,
          'Accept': 'application/json'
        }
      });

      if (!configsRes.ok) {
        throw new Error(`Failed to fetch configs from backend: ${configsRes.statusText}`);
      }

      const companies: any[] = await configsRes.json();
      const activeCompanies = companies.filter(c => 
        ['Public API', 'GraphQL Endpoint', 'Static HTML Page'].includes(c.monitoring_status)
      );

      console.log(`[Worker] Found ${activeCompanies.length} active companies to monitor.`);

      // 2. Trigger individual scans
      // In a worker, we trigger the backend checking controller or process it locally.
      // To keep it highly coordinated, we can call the backend check-now endpoint or perform individual requests.
      // Triggering backend's scan ensures unified database access for storing monitored jobs and watchlists.
      const triggerRes = await fetch(`${env.BACKEND_API_URL}/api/watcher/check-now`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.WORKER_API_SECRET}`,
          'Content-Type': 'application/json'
        }
      });

      if (triggerRes.ok) {
        console.log('[Worker] Successfully delegated checks to backend coordinator.');
      } else {
        console.error(`[Worker] Failed delegating checks: ${triggerRes.statusText}`);
      }

    } catch (err: any) {
      console.error(`[Worker] Error in scheduled monitoring: ${err.message}`);
    }
  }
};
