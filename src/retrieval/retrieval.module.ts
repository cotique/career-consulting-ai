import { Module } from '@nestjs/common';
import { RetrievalController } from './retrieval.controller';
import { RetrievalService } from './retrieval.service';

@Module({
  controllers: [RetrievalController],
  providers: [RetrievalService],
  // Chat (T19) calls search() directly rather than duplicating it.
  exports: [RetrievalService],
})
export class RetrievalModule {}
