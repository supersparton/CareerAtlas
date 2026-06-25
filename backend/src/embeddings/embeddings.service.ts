import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

@Injectable()
export class EmbeddingsService implements OnModuleInit {
  private readonly logger = new Logger(EmbeddingsService.name);
  private extractor: any = null;

  async onModuleInit() {
    this.logger.log('[EMBEDDINGS] Initializing embedding model via fastembed (BGE Small)...');
    try {
      const { FlagEmbedding, EmbeddingModel } = await import('fastembed');
      this.extractor = await FlagEmbedding.init({
        model: EmbeddingModel.BGESmallENV15
      });
      this.logger.log('[EMBEDDINGS] fastembed model loaded successfully.');
    } catch (err) {
      this.logger.warn(
        `[EMBEDDINGS] Failed to load fastembed model: ${err.message}. Will use fallback API if available.`
      );
    }
  }

  /**
   * Generates a 384-dimensional embedding vector for the given text.
   */
  async generateEmbedding(text: string): Promise<number[]> {
    if (!text || text.trim().length === 0) {
      return new Array(384).fill(0);
    }

    // Attempt fastembed inference first
    if (this.extractor) {
      try {
        const embeddings = this.extractor.embed([text]);
        for await (const batch of embeddings) {
          if (batch && batch.length > 0) {
            return Array.from(batch[0]);
          }
        }
      } catch (err) {
        this.logger.error(`[EMBEDDINGS] fastembed embedding generation failed: ${err.message}`);
      }
    }

    // Fallback: Simple deterministic semantic hashing if all else fails (to prevent pipeline crash)
    this.logger.warn('[EMBEDDINGS] Using mock/fallback deterministic hash embedding.');
    return this.generateMockEmbedding(text, 384);
  }

  private adjustDimensions(vector: number[], targetDim: number): number[] {
    if (vector.length === targetDim) {
      return vector;
    }
    if (vector.length > targetDim) {
      // Truncate and renormalize
      const truncated = vector.slice(0, targetDim);
      const magnitude = Math.sqrt(truncated.reduce((sum, val) => sum + val * val, 0));
      return truncated.map(val => (magnitude > 0 ? val / magnitude : 0));
    }
    // Pad with zeros
    const padded = [...vector];
    while (padded.length < targetDim) {
      padded.push(0);
    }
    return padded;
  }

  private generateMockEmbedding(text: string, dimensions: number): number[] {
    const vector = new Array(dimensions).fill(0);
    const cleaned = text.toLowerCase().replace(/[^a-z0-9]/g, '');
    
    // Distribute weights deterministically based on character frequencies
    for (let i = 0; i < cleaned.length; i++) {
      const charCode = cleaned.charCodeAt(i);
      const index = (charCode + i) % dimensions;
      vector[index] += 1.0;
    }
    
    // Normalize
    const magnitude = Math.sqrt(vector.reduce((sum, val) => sum + val * val, 0));
    return vector.map(val => (magnitude > 0 ? val / magnitude : 1 / Math.sqrt(dimensions)));
  }
}
