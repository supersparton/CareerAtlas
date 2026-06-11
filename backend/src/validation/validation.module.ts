import { Module } from '@nestjs/common';
import { ValidationService } from './validation.service';
import { MemoryModule } from '../memory/memory.module';

@Module({
  imports: [MemoryModule],
  providers: [ValidationService],
  exports: [ValidationService],
})
export class ValidationModule {}
