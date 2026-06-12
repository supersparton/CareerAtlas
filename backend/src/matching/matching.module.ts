import { Module } from '@nestjs/common';
import { MatchingService } from './matching.service';
import { MemoryModule } from '../memory/memory.module';

@Module({
  imports: [MemoryModule],
  providers: [MatchingService],
  exports: [MatchingService],
})
export class MatchingModule {}
