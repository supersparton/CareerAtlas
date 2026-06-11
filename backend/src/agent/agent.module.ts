import { Module } from '@nestjs/common';
import { AgentService } from './agent.service';
import { AgentController } from './agent.controller';
import { DiscoveryModule } from '../discovery/discovery.module';
import { IntelligenceModule } from '../intelligence/intelligence.module';
import { MemoryModule } from '../memory/memory.module';
import { NotifierModule } from '../notifier/notifier.module';
import { ProfileModule } from '../profile/profile.module';
import { ValidationModule } from '../validation/validation.module';
import { MatchingModule } from '../matching/matching.module';
import { VectorStoreModule } from '../vector-store/vector-store.module';

@Module({
  imports: [
    DiscoveryModule,
    IntelligenceModule,
    MemoryModule,
    NotifierModule,
    ProfileModule,
    ValidationModule,
    MatchingModule,
    VectorStoreModule,
  ],
  controllers: [AgentController],
  providers: [AgentService],
  exports: [AgentService],
})
export class AgentModule {}
