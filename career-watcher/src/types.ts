export interface SearchTask {
  searchId: string;
  role: string;
  location: string;
}

export interface WatcherJobPayload {
  company: string;
  careerUrl: string;
  searches: SearchTask[];
}

export interface NormalizedJob {
  jobId: string;           // Unique identifier (hash of company + URL)
  company: string;
  title: string;           // Role name
  location: string;
  employmentType?: string; // Full-time, Part-time, Contract, etc.
  remoteStatus?: string;   // Remote, Hybrid, On-site
  postingDate?: string;    // ISO string or raw scraped date
  jobUrl: string;
  description?: string;    // Rich description / description snippet
  source: string;          // e.g., "company_career_page"
}

export interface ScrapeResult {
  searchId: string;
  jobs: NormalizedJob[];
  success: boolean;
  searchPageUrl?: string;
  error?: string;
}

export interface BatchScrapeResult {
  company: string;
  success: boolean;
  results: ScrapeResult[];
  error?: string;
  metrics: {
    startTime: string;
    endTime: string;
    durationMs: number;
    captchaDetected: boolean;
    browserCrashCount: number;
  };
}
