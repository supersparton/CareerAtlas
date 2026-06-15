import { Module } from '@nestjs/common';
import { IntelligenceService } from './intelligence.service';
import { JobIntelligenceService } from './job-intelligence.service';
import { CamoufoxScraperService } from './camoufox-scraper.service';
import { EmbeddingsModule } from '../embeddings/embeddings.module';

@Module({
  imports: [EmbeddingsModule],
  providers: [IntelligenceService, JobIntelligenceService, CamoufoxScraperService],
  exports: [IntelligenceService, JobIntelligenceService, CamoufoxScraperService],
})
export class IntelligenceModule {}
