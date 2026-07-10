import { Module } from '@nestjs/common';
import { ProfileService } from './profile.service';
import { ResumeOptimizerService } from './resume-optimizer.service';
import { ResumesService } from './resumes.service';
import { PdfExportService } from './pdf-export.service';
import { ProfileController } from './profile.controller';
import { EmbeddingsModule } from '../embeddings/embeddings.module';
import { IntelligenceModule } from '../intelligence/intelligence.module';
import { MatchingModule } from '../matching/matching.module';

@Module({
  imports: [EmbeddingsModule, IntelligenceModule, MatchingModule],
  controllers: [ProfileController],
  providers: [ProfileService, ResumeOptimizerService, ResumesService, PdfExportService],
  exports: [ProfileService, ResumeOptimizerService, ResumesService, PdfExportService],
})
export class ProfileModule {}
