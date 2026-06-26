export interface RawJob {
  externalId: string;
  title: string;
  company: string;
  location: string;
  description: string;
  applyUrl: string;
  postedAt?: Date;
}

export interface JobProvider {
  /**
   * Fetch all active jobs for a company slug/tenant
   */
  fetchJobs(companySlug: string): Promise<RawJob[]>;
}
