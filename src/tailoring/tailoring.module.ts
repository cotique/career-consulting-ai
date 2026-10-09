import { Module } from '@nestjs/common';
import { TailoringController } from './tailoring.controller';
import { TailoringService } from './tailoring.service';

@Module({
  controllers: [TailoringController],
  providers: [TailoringService],
})
export class TailoringModule {}
