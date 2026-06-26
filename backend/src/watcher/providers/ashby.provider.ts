import { Injectable, Logger } from '@nestjs/common';
import { JobProvider, RawJob } from './provider.interface';

@Injectable()
export class AshbyProvider implements JobProvider {
  private readonly logger = new Logger(AshbyProvider.name);

  async fetchJobs(companySlug: string): Promise<RawJob[]> {
    this.logger.log(`Fetching Ashby jobs for boardId: ${companySlug}`);
    // Ashby API endpoint
    const url = `https://api.ashbyhq.com/v1/jobs?boardId=${companySlug}`;

    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Ashby API responded with status ${response.status}`);
      }

      const data = await response.json();
      const jobs = data.jobs || [];

      return jobs.map((job: any) => ({
        externalId: String(job.id),
        title: job.title || '',
        company: companySlug,
        location: job.location || 'Remote',
        description: job.descriptionHtml || job.description || '',
        applyUrl: job.jobUrl || '',
        postedAt: job.publishedAt ? new Date(job.publishedAt) : undefined,
      }));
    } catch (err) {
      this.logger.error(`Failed to fetch Ashby jobs for ${companySlug}: ${err.message}`);
      return [];
    }
  }
}
