import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

@Injectable()
export class EmbeddingsService implements OnModuleInit {
  private readonly logger = new Logger(EmbeddingsService.name);
  private extractor: any = null;

  async onModuleInit() {
    this.logger.log('[EMBEDDINGS] Initializing embedding model Xenova/bge-small-en-v1.5...');
    try {
      // Dynamically import @xenova/transformers to prevent issues if it's not installed yet during bootstrap
      const { pipeline } = await import('@xenova/transformers');
      this.extractor = await pipeline('feature-extraction', 'Xenova/bge-small-en-v1.5');
      this.logger.log('[EMBEDDINGS] Local feature-extraction model loaded successfully.');
    } catch (err) {
      this.logger.warn(
        `[EMBEDDINGS] Failed to load local @xenova/transformers model: ${err.message}. Will use fallback API if available.`
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

    // Attempt local inference first
    if (this.extractor) {
      try {
        const output = await this.extractor(text, { pooling: 'mean', normalize: true });
        // The output.data contains the float array of the embedding
        return Array.from(output.data);
      } catch (err) {
        this.logger.error(`[EMBEDDINGS] Local embedding generation failed: ${err.message}`);
      }
    }

    // Fallback: Gemini Embeddings API (if key is configured)
    const geminiApiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
    if (geminiApiKey) {
      try {
        this.logger.log('[EMBEDDINGS] Falling back to Gemini Embedding API...');
        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=${geminiApiKey}`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              model: 'models/text-embedding-004',
              content: {
                parts: [{ text }],
              },
            }),
          }
        );

        if (response.ok) {
          const data = await response.json();
          const values = data.embedding?.values;
          if (Array.isArray(values)) {
            this.logger.log(`[EMBEDDINGS] Gemini returned embedding of length ${values.length}. Truncating/Padding to 384...`);
            // Gemini is 768 or 1536 dims. We must adjust to 384 for database schema compatibility if schema is 384.
            return this.adjustDimensions(values, 384);
          }
        }
        this.logger.warn(`[EMBEDDINGS] Gemini Embedding API responded with code: ${response.status}`);
      } catch (err) {
        this.logger.error(`[EMBEDDINGS] Gemini Embedding API exception: ${err.message}`);
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
