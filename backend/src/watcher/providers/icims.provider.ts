import { Injectable, Logger } from '@nestjs/common';
import { JobProvider, RawJob } from './provider.interface';

@Injectable()
export class ICIMSProvider implements JobProvider {
  private readonly logger = new Logger(ICIMSProvider.name);

  async fetchJobs(companySlug: string): Promise<RawJob[]> {
    this.logger.log(`Fetching iCIMS jobs for: ${companySlug}`);
    const url = `https://api.icims.com/v1/companies/${companySlug}/jobs`;

    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`iCIMS API responded with status ${response.status}`);
      }

      const data = await response.json();
      const jobs = data.jobs || [];

      return jobs.map((job: any) => ({
        externalId: String(job.id),
        title: job.title || '',
        company: companySlug,
        location: job.location?.name || 'Remote',
        description: job.description || '',
        applyUrl: job.applyUrl || '',
      }));
    } catch (err) {
      this.logger.error(`Failed to fetch iCIMS jobs for ${companySlug}: ${err.message}`);
      return [];
    }
  }
}
