import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { QdrantClient } from '@qdrant/js-client-rest';
import { createHash } from 'crypto';

@Injectable()
export class QdrantService implements OnModuleInit {
  private readonly logger = new Logger(QdrantService.name);
  private client: QdrantClient;

  async onModuleInit() {
    const url = process.env.QDRANT_URL || 'http://localhost:6333';
    const apiKey = process.env.QDRANT_API_KEY || undefined;

    this.logger.log(`[QDRANT] Connecting to Qdrant at ${url}...`);
    this.client = new QdrantClient({ url, apiKey });

    // Initialize collections
    await this.initializeCollections();
  }

  getClient(): QdrantClient {
    return this.client;
  }

  /**
   * Helper utility to convert a string (like a job ID) to a valid UUID format deterministically.
   */
  static stringToUuid(str: string): string {
    const hash = createHash('md5').update(str).digest('hex');
    return [
      hash.substring(0, 8),
      hash.substring(8, 12),
      `4${hash.substring(13, 16)}`, // version 4
      `a${hash.substring(17, 20)}`, // variant
      hash.substring(20, 32)
    ].join('-');
  }

  private async initializeCollections() {
    try {
      this.logger.log('[QDRANT] Verifying collections...');
      const collections = await this.client.getCollections();
      const collectionNames = collections.collections.map(c => c.name);

      if (!collectionNames.includes('user_embeddings')) {
        this.logger.log('[QDRANT] Creating collection "user_embeddings"...');
        await this.client.createCollection('user_embeddings', {
          vectors: { size: 384, distance: 'Cosine' }
        });
      }

      if (!collectionNames.includes('job_embeddings')) {
        this.logger.log('[QDRANT] Creating collection "job_embeddings"...');
        await this.client.createCollection('job_embeddings', {
          vectors: { size: 384, distance: 'Cosine' }
        });
      }
      this.logger.log('[QDRANT] Collections initialized successfully.');
    } catch (err) {
      this.logger.error(`[QDRANT] Failed to initialize collections: ${err.message}`);
    }
  }
}
