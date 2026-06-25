import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import * as crypto from 'crypto';
import Redis from 'ioredis';

@Injectable()
export class MemoryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MemoryService.name);
  private redis: Redis | null = null;

  async onModuleInit() {
    this.logger.log('[MEMORY] Connecting to Redis for job state cache...');
    try {
      const redisUrl = process.env.REDIS_URL;
      if (redisUrl) {
        this.redis = new Redis(redisUrl);
      } else {
        this.redis = new Redis({
          host: process.env.REDIS_HOST || 'localhost',
          port: parseInt(process.env.REDIS_PORT || '6379', 10),
          password: process.env.REDIS_PASSWORD || undefined,
          username: process.env.REDIS_USERNAME || undefined,
          tls: process.env.REDIS_TLS === 'true' ? {} : undefined,
        });
      }
      this.logger.log('[MEMORY] Connected to Redis successfully.');
    } catch (err) {
      this.logger.error(`[MEMORY] Failed to connect to Redis: ${err.message}`);
    }
  }

  async onModuleDestroy() {
    if (this.redis) {
      await this.redis.quit();
    }
  }

  getRedisClient(): Redis | null {
    return this.redis;
  }

  generateJobHash(company: string, title: string, location: string, source: string): string {
    const uniqueString = `${company.toLowerCase().trim()}|${title.toLowerCase().trim()}|${location.toLowerCase().trim()}|${source.toLowerCase().trim()}`;
    return crypto.createHash('sha256').update(uniqueString).digest('hex');
  }

  // LLM Cache check: Has this job description already been scored by LLM?
  async isJobProcessed(company: string, title: string, location: string, source: string): Promise<boolean> {
    if (!this.redis) return false;
    try {
      const hash = this.generateJobHash(company, title, location, source);
      const exists = await this.redis.sismember('careeratlas:processed_jobs', hash);
      const result = exists === 1;
      if (result) {
        this.logger.log(`[MEMORY] LLM Cache hit: Skipped scoring for "${title}" at "${company}"`);
      }
      return result;
    } catch (err) {
      this.logger.error(`[MEMORY] Redis sismember failed: ${err.message}`);
      return false;
    }
  }

  async markJobAsProcessed(company: string, title: string, location: string, source: string): Promise<void> {
    if (!this.redis) return;
    try {
      const hash = this.generateJobHash(company, title, location, source);
      await this.redis.sadd('careeratlas:processed_jobs', hash);
      // Set 24 hour TTL to prevent infinite memory growth
      await this.redis.expire('careeratlas:processed_jobs', 86400);
      this.logger.log(`[MEMORY] Saved processed job hash to Redis: ${hash}`);
    } catch (err) {
      this.logger.error(`[MEMORY] Redis sadd failed: ${err.message}`);
    }
  }

  // Match Storage check: Has this job already been accepted/notified?
  async isJobMatched(company: string, title: string, location: string, source: string): Promise<boolean> {
    if (!this.redis) return false;
    try {
      const hash = this.generateJobHash(company, title, location, source);
      const exists = await this.redis.sismember('careeratlas:matched_jobs', hash);
      return exists === 1;
    } catch (err) {
      this.logger.error(`[MEMORY] Redis sismember failed: ${err.message}`);
      return false;
    }
  }

  async markJobAsMatched(company: string, title: string, location: string, source: string): Promise<void> {
    if (!this.redis) return;
    try {
      const hash = this.generateJobHash(company, title, location, source);
      await this.redis.sadd('careeratlas:matched_jobs', hash);
      await this.redis.expire('careeratlas:matched_jobs', 86400);
      this.logger.log(`[MEMORY] Saved matched job hash to Redis: ${hash}`);
    } catch (err) {
      this.logger.error(`[MEMORY] Redis sadd failed: ${err.message}`);
    }
  }
}
