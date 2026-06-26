import { Injectable, Logger } from '@nestjs/common';
import { JobProvider, RawJob } from './provider.interface';

@Injectable()
export class WorkdayProvider implements JobProvider {
  private readonly logger = new Logger(WorkdayProvider.name);

  async fetchJobs(companySlug: string): Promise<RawJob[]> {
    this.logger.log(`Fetching Workday jobs for tenant: ${companySlug}`);
    
    // For Workday, the company slug is the subdomain and often the tenant name
    // e.g. companySlug = 'cisco', domain = 'cisco.myworkdayjobs.com'
    const domain = companySlug.includes('.') ? companySlug : `${companySlug}.myworkdayjobs.com`;
    const cleanSlug = companySlug.split('.')[0];
    
    // We try to guess the tenant name. Usually it is identical to the subdomain or uses lowercase/uppercase variations.
    // We will attempt with the clean subdomain first.
    const url = `https://${domain}/wday/cxs/${cleanSlug}/${cleanSlug}/jobs`;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify({
          appliedFacets: {},
          limit: 20,
          offset: 0,
          searchText: "",
        }),
      });

      if (!response.ok) {
        throw new Error(`Workday API responded with status ${response.status}`);
      }

      const data = await response.json();
      const jobPostings = data.jobPostings || [];

      const rawJobs: RawJob[] = [];

      // Only fetch the full descriptions for the top 15 jobs to prevent rate limits and socket exhaustion
      const jobsToFetch = jobPostings.slice(0, 15);

      for (const job of jobsToFetch) {
        try {
          const detailUrl = `https://${domain}/wday/cxs/${cleanSlug}/${cleanSlug}${job.externalPath}`;
          const detailResponse = await fetch(detailUrl);
          
          let description = '';
          if (detailResponse.ok) {
            const detailData = await detailResponse.json();
            description = detailData.jobPostingInfo?.jobDescription || '';
          }

          rawJobs.push({
            externalId: job.bulletPoints?.[0] || job.externalPath || String(Math.random()),
            title: job.title || '',
            company: cleanSlug,
            location: job.locationsText || 'Remote',
            description: description || `Workday Job Listing: ${job.title}`,
            applyUrl: `https://${domain}${job.externalPath}`,
          });
        } catch (detailErr) {
          // Fallback to basic metadata if detail fetch fails
          rawJobs.push({
            externalId: job.externalPath || String(Math.random()),
            title: job.title || '',
            company: cleanSlug,
            location: job.locationsText || 'Remote',
            description: `Workday Job Listing: ${job.title}`,
            applyUrl: `https://${domain}${job.externalPath}`,
          });
        }
      }

      return rawJobs;
    } catch (err) {
      this.logger.error(`Failed to fetch Workday jobs for ${companySlug}: ${err.message}`);
      return [];
    }
  }
}
