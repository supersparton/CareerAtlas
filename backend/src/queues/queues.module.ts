import { Module, Global } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { PipelineCoordinatorService } from './pipeline-coordinator.service';
import { DiscoveryWorker } from './discovery.worker';
import { ValidationWorker } from './validation.worker';
import { ScrapingWorker } from './scraping.worker';
import { IntelligenceWorker } from './intelligence.worker';
import { EmbeddingWorker } from './embedding.worker';
import { MatchingWorker } from './matching.worker';
import { DiscoveryModule } from '../discovery/discovery.module';
import { ValidationModule } from '../validation/validation.module';
import { IntelligenceModule } from '../intelligence/intelligence.module';
import { EmbeddingsModule } from '../embeddings/embeddings.module';
import { MemoryModule } from '../memory/memory.module';
import { NotifierModule } from '../notifier/notifier.module';
import { ProfileModule } from '../profile/profile.module';
import { MatchingModule } from '../matching/matching.module';

@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      useFactory: () => {
        const redisUrl = process.env.REDIS_URL;
        if (redisUrl) {
          try {
            const parsed = new URL(redisUrl);
            return {
              connection: {
                host: parsed.hostname,
                port: parsed.port ? parseInt(parsed.port, 10) : 6379,
                username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
                password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
                tls: parsed.protocol === 'rediss:' ? {} : undefined,
              },
            };
          } catch (err) {
            // Fail silently and fall back to individual keys
          }
        }
        return {
          connection: {
            host: process.env.REDIS_HOST || 'localhost',
            port: parseInt(process.env.REDIS_PORT || '6379', 10),
            password: process.env.REDIS_PASSWORD || undefined,
            username: process.env.REDIS_USERNAME || undefined,
            tls: process.env.REDIS_TLS === 'true' ? {} : undefined,
          },
        };
      },
    }),
    BullModule.registerQueue(
      { 
        name: 'job-discovery',
        defaultJobOptions: {
          removeOnComplete: { age: 600}, // Keep completed discovery runs for 10 minutes or max 20 jobs
          removeOnFail: { age: 3600 },   // Keep failed runs for 1 hour or max 100 jobs
        }
      },
      { 
        name: 'job-validation',
        defaultJobOptions: {
          removeOnComplete: true,                      // Delete validation jobs immediately upon success
          removeOnFail: { age: 1800},      // Keep failed validation jobs for 30 minutes
        }
      },
      { 
        name: 'job-scraping',
        defaultJobOptions: {
          removeOnComplete: true,
          removeOnFail: { age: 1800 },
        }
      },
      { 
        name: 'job-intelligence',
        defaultJobOptions: {
          removeOnComplete: true,                      // Delete intelligence jobs immediately upon success
          removeOnFail: { age: 1800},
        }
      },
      { 
        name: 'job-embedding',
        defaultJobOptions: {
          removeOnComplete: true,                      // Delete embedding jobs immediately upon success
          removeOnFail: { age: 1800},
        }
      },
      { 
        name: 'job-matching',
        defaultJobOptions: {
          removeOnComplete: { age: 600},
          removeOnFail: { age: 3600 },
        }
      }
    ),
    DiscoveryModule,
    ValidationModule,
    IntelligenceModule,
    EmbeddingsModule,
    MemoryModule,
    NotifierModule,
    ProfileModule,
    MatchingModule,
  ],
  providers: [
    PipelineCoordinatorService,
    DiscoveryWorker,
    ValidationWorker,
    ScrapingWorker,
    IntelligenceWorker,
    EmbeddingWorker,
    MatchingWorker,
  ],
  exports: [
    PipelineCoordinatorService,
    BullModule, // Export BullModule so other modules can inject the registered queues
  ],
})
export class QueuesModule {}
