import { Module } from '@nestjs/common';
import { AgentModule } from './agent/agent.module';
import { ConfigModule } from '@nestjs/config';
import { VectorStoreModule } from './vector-store/vector-store.module';
import { LlmGatewayModule } from './llm-gateway/llm-gateway.module';
import { QueuesModule } from './queues/queues.module';
import { WatcherModule } from './watcher/watcher.module';

@Module({
  imports: [
    ConfigModule.forRoot({ envFilePath: '.env' }), // Load .env from parent folder
    VectorStoreModule,
    LlmGatewayModule,
    QueuesModule,
    AgentModule,
    WatcherModule
  ],
})
export class AppModule {}
