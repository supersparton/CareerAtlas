import { Module } from '@nestjs/common';
import { AgentService } from './agent.service';
import { DiscoveryModule } from '../discovery/discovery.module';
import { IntelligenceModule } from '../intelligence/intelligence.module';
import { MemoryModule } from '../memory/memory.module';
import { NotifierModule } from '../notifier/notifier.module';

@Module({
  imports: [DiscoveryModule, IntelligenceModule, MemoryModule, NotifierModule],
  providers: [AgentService],
})
export class AgentModule {}
