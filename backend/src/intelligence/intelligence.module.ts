import { Module } from '@nestjs/common';
import { JobIntelligenceService } from './job-intelligence.service';
import { CamoufoxScraperService } from './camoufox-scraper.service';
import { EmbeddingsModule } from '../embeddings/embeddings.module';

@Module({
  imports: [EmbeddingsModule],
  providers: [JobIntelligenceService, CamoufoxScraperService],
  exports: [JobIntelligenceService, CamoufoxScraperService],
})
export class IntelligenceModule {}
