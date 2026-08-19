import { Global, Module } from '@nestjs/common';
import { SecretsService } from './secrets.service';

// Global — secrets access is a cross-cutting concern every domain module
// may need (DB connection string, LLM provider keys, etc.), not worth
// re-importing everywhere.
@Global()
@Module({
  providers: [SecretsService],
  exports: [SecretsService],
})
export class ConfigModule {}
