import { Global, Module } from '@nestjs/common';
import { BlobStorageService } from './blob-storage.service';

// Global for the same reason as DbModule and LlmModule — shared infrastructure
// that several domain modules will consume (resumes now, generated documents
// later), not something any one of them owns.
@Global()
@Module({
  providers: [BlobStorageService],
  exports: [BlobStorageService],
})
export class StorageModule {}
