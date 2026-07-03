import { Worker, Job } from 'bullmq';
import { getRedisConnectionOptions, CONFIG } from './config';
import { WatcherJobPayload, BatchScrapeResult } from './types';
import { executeCompanyScrapeBatch } from './browser/search-runner';

console.log('----------------------------------------------------');
console.log('  Career Watcher Scraper Worker Starting...');
console.log(`  Connecting to Redis Host: ${CONFIG.redisHost}:${CONFIG.redisPort}`);
console.log('----------------------------------------------------');

const connection = getRedisConnectionOptions();

const worker = new Worker(
  'career-watcher-tasks',
  async (job: Job<WatcherJobPayload>) => {
    console.log(`[WORKER] Received Job ID: ${job.id} for company: ${job.data.company}`);
    
    const startTime = new Date();
    let browserCrashCount = 0;
    let captchaDetected = false;

    try {
      // Update progress log
      await job.updateProgress(10);
      
      const results = await executeCompanyScrapeBatch(job.data, (progressLog) => {
        console.log(`[JOB ${job.id}] ${progressLog}`);
        if (progressLog.includes('CAPTCHA')) {
          captchaDetected = true;
        }
        if (progressLog.includes('crash') || progressLog.includes('crashed')) {
          browserCrashCount++;
        }
      });

      await job.updateProgress(100);

      const endTime = new Date();
      const durationMs = endTime.getTime() - startTime.getTime();

      const batchResult: BatchScrapeResult = {
        company: job.data.company,
        success: true,
        results,
        metrics: {
          startTime: startTime.toISOString(),
          endTime: endTime.toISOString(),
          durationMs,
          captchaDetected,
          browserCrashCount
        }
      };

      console.log(`[WORKER] Job ${job.id} completed successfully in ${durationMs}ms`);
      return batchResult;

    } catch (err: any) {
      console.error(`[WORKER] Job ${job.id} failed with error: ${err.message}`);
      
      const endTime = new Date();
      const durationMs = endTime.getTime() - startTime.getTime();

      const batchResult: BatchScrapeResult = {
        company: job.data.company,
        success: false,
        results: job.data.searches.map(s => ({
          searchId: s.searchId,
          jobs: [],
          success: false,
          error: err.message
        })),
        error: err.message,
        metrics: {
          startTime: startTime.toISOString(),
          endTime: endTime.toISOString(),
          durationMs,
          captchaDetected,
          browserCrashCount
        }
      };

      return batchResult;
    }
  },
  {
    connection,
    concurrency: 1, // Only 1 browser batch at a time per worker instance to preserve CPU
    limiter: {
      max: 5,
      duration: 10000 // Limit to 5 batch jobs per 10 seconds to prevent rate limiting
    }
  }
);

worker.on('active', (job) => {
  console.log(`[WORKER] Job ${job.id} is now active.`);
});

worker.on('completed', (job, result) => {
  console.log(`[WORKER] Job ${job.id} marked as completed.`);
});

worker.on('failed', (job, err) => {
  console.error(`[WORKER] Job ${job?.id} failed: ${err.message}`);
});

// Handle graceful shutdown
process.on('SIGTERM', async () => {
  console.log('[WORKER] SIGTERM received. Shutting down worker...');
  await worker.close();
  console.log('[WORKER] Worker closed.');
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('[WORKER] SIGINT received. Shutting down worker...');
  await worker.close();
  console.log('[WORKER] Worker closed.');
  process.exit(0);
});
