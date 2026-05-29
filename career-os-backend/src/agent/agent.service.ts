import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { DiscoveryService } from '../discovery/discovery.service';
import { IntelligenceService } from '../intelligence/intelligence.service';
import { MemoryService } from '../memory/memory.service';
import { NotifierService } from '../notifier/notifier.service';

@Injectable()
export class AgentService implements OnApplicationBootstrap {
  private readonly logger = new Logger(AgentService.name);

  constructor(
    private readonly discoveryService: DiscoveryService,
    private readonly intelligenceService: IntelligenceService,
    private readonly memoryService: MemoryService,
    private readonly notifierService: NotifierService,
  ) {}

  async onApplicationBootstrap() {
    this.logger.log('Agent Bootstrapped. Starting Hermes Agent Loop...');
    // In production, this would be a cron job, but we'll run it once for testing.
    await this.runWorkflow('software engineer', 'Remote');
  }

  async runWorkflow(searchTerm: string, location: string) {
    this.logger.log('--- STARTING JOB HUNT WORKFLOW ---');

    // 1. Explore LinkedIn using Playwright Scraper
    const jobs = await this.discoveryService.scrapeLinkedInJobs(searchTerm, location);

    for (const job of jobs) {
      // 2. Skip if already suggested
      if (this.memoryService.isJobSeen(job.title, job.company)) {
        this.logger.log(`⏭️ Skipped: [${job.title} at ${job.company}] - Already seen.`);
        continue;
      }

      // 3. Score the company and match against user profile
      const evaluation = await this.intelligenceService.scoreJob(job.title, job.company, job.descriptionSnippet);

      if (evaluation.isFakeOrSpam) {
        this.logger.warn(`🚩 Skipped: [${job.title} at ${job.company}] - Flagged as fake/spam.`);
        this.memoryService.markJobAsSeen(job.title, job.company); // mark to ignore next time
        continue;
      }

      if (evaluation.matchScore < 60) {
        this.logger.log(`🔻 Skipped: [${job.title} at ${job.company}] - Low match score (${evaluation.matchScore}/100)`);
        this.memoryService.markJobAsSeen(job.title, job.company);
        continue;
      }

      // 4. Success! A high quality job match.
      this.logger.log(`🎯 HIGH MATCH FOUND: ${job.title} at ${job.company} (Score: ${evaluation.matchScore}/100)`);
      this.logger.log(`Reasoning: ${evaluation.reasoning}`);
      this.logger.log(`Link: ${job.url}`);

      // Mark as seen so we don't alert again
      this.memoryService.markJobAsSeen(job.title, job.company);

      // Send Telegram Alert
      await this.notifierService.sendJobAlert(
        job.title,
        job.company,
        evaluation.matchScore,
        evaluation.reasoning,
        job.url
      );
    }

    this.logger.log('--- WORKFLOW COMPLETE ---');
  }
}
