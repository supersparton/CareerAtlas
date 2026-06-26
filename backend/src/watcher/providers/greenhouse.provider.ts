import { Injectable, Logger } from '@nestjs/common';
import { JobProvider, RawJob } from './provider.interface';

@Injectable()
export class GreenhouseProvider implements JobProvider {
  private readonly logger = new Logger(GreenhouseProvider.name);

  async fetchJobs(companySlug: string): Promise<RawJob[]> {
    this.logger.log(`Fetching Greenhouse jobs for slug: ${companySlug}`);
    const url = `https://boards-api.greenhouse.io/v1/boards/${companySlug}/jobs?content=true`;

    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Greenhouse API responded with status ${response.status}`);
      }

      const data = await response.json();
      const jobs = data.jobs || [];

      return jobs.map((job: any) => ({
        externalId: String(job.id),
        title: job.title || '',
        company: companySlug,
        location: job.location?.name || 'Remote',
        description: job.content || '',
        applyUrl: job.absolute_url || '',
        postedAt: job.updated_at ? new Date(job.updated_at) : undefined,
      }));
    } catch (err) {
      this.logger.error(`Failed to fetch Greenhouse jobs for ${companySlug}: ${err.message}`);
      return [];
    }
  }
}
