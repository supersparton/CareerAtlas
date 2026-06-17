import { Module } from '@nestjs/common';
import { AgentService } from './agent.service';
import { AgentController } from './agent.controller';
import { ProfileModule } from '../profile/profile.module';
import { VectorStoreModule } from '../vector-store/vector-store.module';

@Module({
  imports: [
    ProfileModule,
    VectorStoreModule,
  ],
  controllers: [AgentController],
  providers: [AgentService],
  exports: [AgentService],
})
export class AgentModule {}
