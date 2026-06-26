import { Injectable, Logger } from '@nestjs/common';
import { JobProvider, RawJob } from './provider.interface';

@Injectable()
export class LeverProvider implements JobProvider {
  private readonly logger = new Logger(LeverProvider.name);

  async fetchJobs(companySlug: string): Promise<RawJob[]> {
    this.logger.log(`Fetching Lever jobs for slug: ${companySlug}`);
    const url = `https://api.lever.co/v0/postings/${companySlug}`;

    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Lever API responded with status ${response.status}`);
      }

      const jobs = await response.json();
      if (!Array.isArray(jobs)) {
        this.logger.warn(`Lever API returned unexpected structure for ${companySlug}`);
        return [];
      }

      return jobs.map((job: any) => ({
        externalId: String(job.id),
        title: job.text || '',
        company: companySlug,
        location: job.categories?.location || 'Remote',
        description: job.descriptionPlain || job.description || '',
        applyUrl: job.hostedUrl || '',
        postedAt: job.createdAt ? new Date(job.createdAt) : undefined,
      }));
    } catch (err) {
      this.logger.error(`Failed to fetch Lever jobs for ${companySlug}: ${err.message}`);
      return [];
    }
  }
}
