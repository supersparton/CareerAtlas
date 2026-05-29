import { Module } from '@nestjs/common';
import { IntelligenceService } from './intelligence.service';

@Module({
  providers: [IntelligenceService],
  exports: [IntelligenceService],
})
export class IntelligenceModule {}
