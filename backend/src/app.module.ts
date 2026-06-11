import { Module } from '@nestjs/common';
import { AgentModule } from './agent/agent.module';
import { ConfigModule } from '@nestjs/config';
import { VectorStoreModule } from './vector-store/vector-store.module';

@Module({
  imports: [
    ConfigModule.forRoot({ envFilePath: '.env' }), // Load .env from parent folder
    VectorStoreModule,
    AgentModule
  ],
})
export class AppModule {}
