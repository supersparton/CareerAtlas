import * as crypto from 'crypto';

export interface Job {
  jobId: string;
  source: string;
  title: string;
  company: string;
  location: string;
  description: string;
  applyUrl: string;
}

export function generateJobId(source: string, company: string, title: string, url: string): string {
  const data = `${source.toLowerCase().trim()}|${company.toLowerCase().trim()}|${title.toLowerCase().trim()}|${url.trim()}`;
  return crypto.createHash('sha256').update(data).digest('hex').substring(0, 16);
}
