import { Global, Module } from '@nestjs/common';
import { JobQueueService } from './job-queue.service';

// Global for the same reason as ConfigModule/DbModule/LlmModule — cross-cutting
// infra a future domain module (the application tracker, retrieval ingestion)
// will consume without re-importing it.
@Global()
@Module({
  providers: [JobQueueService],
  exports: [JobQueueService],
})
export class JobsModule {}
