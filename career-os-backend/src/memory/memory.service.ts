import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

@Injectable()
export class MemoryService {
  private readonly logger = new Logger(MemoryService.name);
  private readonly memoryFilePath = path.join(process.cwd(), '..', 'seen_jobs.json');

  constructor() {
    this.ensureFileExists();
  }

  private ensureFileExists() {
    if (!fs.existsSync(this.memoryFilePath)) {
      fs.writeFileSync(this.memoryFilePath, JSON.stringify([]), 'utf-8');
    }
  }

  getSeenJobs(): string[] {
    try {
      const data = fs.readFileSync(this.memoryFilePath, 'utf-8');
      return JSON.parse(data);
    } catch (e) {
      this.logger.error('Failed to read seen_jobs.json', e);
      return [];
    }
  }

  saveSeenJob(jobHash: string) {
    const seenJobs = this.getSeenJobs();
    if (!seenJobs.includes(jobHash)) {
      seenJobs.push(jobHash);
      fs.writeFileSync(this.memoryFilePath, JSON.stringify(seenJobs, null, 2), 'utf-8');
    }
  }

  generateJobHash(title: string, company: string): string {
    const uniqueString = `${title}|${company}`.toLowerCase().trim();
    return crypto.createHash('sha256').update(uniqueString).digest('hex');
  }

  isJobSeen(title: string, company: string): boolean {
    const hash = this.generateJobHash(title, company);
    return this.getSeenJobs().includes(hash);
  }

  markJobAsSeen(title: string, company: string) {
    const hash = this.generateJobHash(title, company);
    this.saveSeenJob(hash);
  }
}
