import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { WatcherService } from './watcher.service';
import { WatcherController } from './watcher.controller';
import { CompanyResolverService } from './company-resolver.service';
import { GreenhouseProvider } from './providers/greenhouse.provider';
import { LeverProvider } from './providers/lever.provider';
import { AshbyProvider } from './providers/ashby.provider';
import { WorkdayProvider } from './providers/workday.provider';
import { ICIMSProvider } from './providers/icims.provider';
import { CustomConfigProvider } from './providers/custom-config.provider';
import { WatcherDiscoveryWorker } from './queues/watcher-discovery.worker';
import { LlmGatewayModule } from '../llm-gateway/llm-gateway.module';
import { VectorStoreModule } from '../vector-store/vector-store.module';

@Module({
  imports: [
    VectorStoreModule,
    LlmGatewayModule,
    BullModule.registerQueue({
      name: 'watcher-discovery',
      defaultJobOptions: {
        removeOnComplete: { age: 3600 }, // Keep history for 1 hour
        removeOnFail: { age: 86400 },    // Keep failures for 24 hours
      },
    }),
  ],
  controllers: [WatcherController],
  providers: [
    WatcherService,
    CompanyResolverService,
    GreenhouseProvider,
    LeverProvider,
    AshbyProvider,
    WorkdayProvider,
    ICIMSProvider,
    CustomConfigProvider,
    WatcherDiscoveryWorker,
  ],
  exports: [WatcherService],
})
export class WatcherModule {}
