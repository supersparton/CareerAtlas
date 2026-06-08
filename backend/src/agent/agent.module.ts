import { Module } from '@nestjs/common';
import { AgentService } from './agent.service';
import { ProfileService } from './profile.service';
import { AgentController } from './agent.controller';
import { DiscoveryModule } from '../discovery/discovery.module';
import { IntelligenceModule } from '../intelligence/intelligence.module';
import { MemoryModule } from '../memory/memory.module';
import { NotifierModule } from '../notifier/notifier.module';

@Module({
  imports: [DiscoveryModule, IntelligenceModule, MemoryModule, NotifierModule],
  controllers: [AgentController],
  providers: [AgentService, ProfileService],
  exports: [ProfileService],
})
export class AgentModule {}
