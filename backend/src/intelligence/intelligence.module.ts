import { Module } from '@nestjs/common';
import { IntelligenceService } from './intelligence.service';
import { JobIntelligenceService } from './job-intelligence.service';
import { EmbeddingsModule } from '../embeddings/embeddings.module';

@Module({
  imports: [EmbeddingsModule],
  providers: [IntelligenceService, JobIntelligenceService],
  exports: [IntelligenceService, JobIntelligenceService],
})
export class IntelligenceModule {}
