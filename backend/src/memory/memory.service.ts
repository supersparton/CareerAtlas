import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

@Injectable()
export class MemoryService {
  private readonly logger = new Logger(MemoryService.name);
  private readonly processedFilePath = path.join(process.cwd(), '..', 'processed_jobs.json');
  private readonly matchedFilePath = path.join(process.cwd(), '..', 'seen_jobs.json');

  constructor() {
    this.ensureFilesExist();
  }

  private ensureFilesExist() {
    if (!fs.existsSync(this.processedFilePath)) {
      fs.writeFileSync(this.processedFilePath, JSON.stringify([]), 'utf-8');
    }
    if (!fs.existsSync(this.matchedFilePath)) {
      fs.writeFileSync(this.matchedFilePath, JSON.stringify([]), 'utf-8');
    }
  }

  private readHashes(filePath: string): string[] {
    try {
      if (fs.existsSync(filePath)) {
        const data = fs.readFileSync(filePath, 'utf-8');
        return JSON.parse(data);
      }
    } catch (e) {
      this.logger.error(`Failed to read ${path.basename(filePath)}`, e);
    }
    return [];
  }

  private saveHash(filePath: string, hash: string) {
    try {
      const hashes = this.readHashes(filePath);
      if (!hashes.includes(hash)) {
        hashes.push(hash);
        fs.writeFileSync(filePath, JSON.stringify(hashes, null, 2), 'utf-8');
        this.logger.log(`[MEMORY] Saved hash to ${path.basename(filePath)}: ${hash}`);
      }
    } catch (e) {
      this.logger.error(`Failed to save hash to ${path.basename(filePath)}`, e);
    }
  }

  generateJobHash(company: string, title: string, location: string, source: string): string {
    const uniqueString = `${company.toLowerCase().trim()}|${title.toLowerCase().trim()}|${location.toLowerCase().trim()}|${source.toLowerCase().trim()}`;
    return crypto.createHash('sha256').update(uniqueString).digest('hex');
  }

  // LLM Cache check: Has this job description already been scored by LLM?
  isJobProcessed(company: string, title: string, location: string, source: string): boolean {
    const hash = this.generateJobHash(company, title, location, source);
    const result = this.readHashes(this.processedFilePath).includes(hash);
    if (result) {
      this.logger.log(`[MEMORY] LLM Cache hit: Skipped scoring for "${title}" at "${company}"`);
    }
    return result;
  }

  markJobAsProcessed(company: string, title: string, location: string, source: string) {
    const hash = this.generateJobHash(company, title, location, source);
    this.saveHash(this.processedFilePath, hash);
  }

  // Match Storage check: Has this job already been accepted/notified?
  isJobMatched(company: string, title: string, location: string, source: string): boolean {
    const hash = this.generateJobHash(company, title, location, source);
    const result = this.readHashes(this.matchedFilePath).includes(hash);
    return result;
  }

  markJobAsMatched(company: string, title: string, location: string, source: string) {
    const hash = this.generateJobHash(company, title, location, source);
    this.saveHash(this.matchedFilePath, hash);
  }
}
