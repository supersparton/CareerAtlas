import { Module, Global } from '@nestjs/common';
import { DatabaseService } from './database.service';
import { QdrantService } from './qdrant.service';

@Global()
@Module({
  providers: [DatabaseService, QdrantService],
  exports: [DatabaseService, QdrantService],
})
export class VectorStoreModule {}
