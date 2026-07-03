import { QueueEventsListener, QueueEventsHost, OnQueueEvent } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { DatabaseService } from '../vector-store/database.service';
import { NotifierService } from '../notifier/notifier.service';

@QueueEventsListener('career-watcher-tasks')
export class CompanyWatcherEventsListener extends QueueEventsHost {
  private readonly logger = new Logger(CompanyWatcherEventsListener.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly notifier: NotifierService,
  ) {
    super();
  }

  @OnQueueEvent('completed')
  async onCompleted({ jobId, returnvalue }: { jobId: string; returnvalue: any }) {
    this.logger.log(`[COMPANY-WATCHER-LISTENER] Job completed: ${jobId}`);

    if (!returnvalue) {
      this.logger.warn(`[COMPANY-WATCHER-LISTENER] Job ${jobId} completed but returned empty value.`);
      return;
    }

    try {
      let batchResult = returnvalue;
      if (typeof returnvalue === 'string') {
        batchResult = JSON.parse(returnvalue);
      }
      if (!batchResult || !batchResult.success) {
        this.logger.warn(`[COMPANY-WATCHER-LISTENER] Scraping batch for ${batchResult?.company || 'unknown'} completed with errors: ${batchResult?.error || 'unknown'}`);
        return;
      }

      this.logger.log(`[COMPANY-WATCHER-LISTENER] Processing scraping results for company: ${batchResult.company}`);

      for (const searchResult of batchResult.results) {
        if (!searchResult.success) {
          this.logger.warn(`[COMPANY-WATCHER-LISTENER] Search for ID ${searchResult.searchId} failed: ${searchResult.error}`);
          continue;
        }

        // Composite ID format: userId_watchId
        const [userIdStr, watchIdStr] = searchResult.searchId.split('_');
        const userId = parseInt(userIdStr, 10);
        const watchId = parseInt(watchIdStr, 10);

        if (isNaN(userId) || isNaN(watchId)) {
          this.logger.error(`[COMPANY-WATCHER-LISTENER] Invalid searchId format in result: ${searchResult.searchId}`);
          continue;
        }

        // Get watch details to include in the notification context
        const watchRes = await this.db.query(
          'SELECT role, location FROM user_career_watches WHERE id = $1',
          [watchId]
        );

        if (watchRes.rows.length === 0) {
          this.logger.warn(`[COMPANY-WATCHER-LISTENER] Saved watch ID ${watchId} no longer exists. Skipping alerts.`);
          continue;
        }

        const watch = watchRes.rows[0];

        // Process found jobs
        let newJobsAlerted = 0;
        for (const job of searchResult.jobs) {
          try {
            // First, persist the job result into the results table
            await this.db.query(
              `INSERT INTO results (user_id, job_id, company, title, location, source, url, score, reasoning, status)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
               ON CONFLICT (user_id, job_id) DO UPDATE 
               SET url = EXCLUDED.url, title = EXCLUDED.title, location = EXCLUDED.location`,
              [
                userId,
                job.jobId,
                batchResult.company,
                job.title,
                job.location || watch.location,
                'company_career_page',
                job.jobUrl,
                100,
                `Discovered via active career page watcher for role: "${watch.role}" at "${batchResult.company}" in "${watch.location}".`,
                'matched'
              ]
            );

            // Deduplicate: try inserting into notifications table
            const insertRes = await this.db.query(
              `INSERT INTO user_watch_notifications (user_id, job_id)
               VALUES ($1, $2)
               ON CONFLICT (user_id, job_id) DO NOTHING
               RETURNING 1`,
              [userId, job.jobId]
            );

            // If a row was returned, it means it's a new job for this user!
            if (insertRes.rows.length > 0) {
              this.logger.log(`[COMPANY-WATCHER-LISTENER] Alerting user ${userId} for new job: "${job.title}" at "${batchResult.company}"`);
              
              await this.notifier.sendWatcherAlert(
                batchResult.company,
                watch.role,
                watch.location,
                job.title,
                job.jobUrl,
                searchResult.searchPageUrl
              );
              newJobsAlerted++;
            }
          } catch (jobErr: any) {
            this.logger.error(`[COMPANY-WATCHER-LISTENER] Error processing job alert: ${jobErr.message}`);
          }
        }

        if (newJobsAlerted > 0) {
          this.logger.log(`[COMPANY-WATCHER-LISTENER] Dispatched ${newJobsAlerted} new notifications for watch ID: ${watchId}`);
        }
      }
    } catch (err: any) {
      this.logger.error(`[COMPANY-WATCHER-LISTENER] Error parsing or processing completed job results: ${err.message}`);
    }
  }

  @OnQueueEvent('failed')
  async onFailed({ jobId, failedReason }: { jobId: string; failedReason: string }) {
    this.logger.error(`[COMPANY-WATCHER-LISTENER] Scraping job ${jobId} failed. Reason: ${failedReason}`);
  }
}
