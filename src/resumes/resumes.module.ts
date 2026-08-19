import { Module } from '@nestjs/common';
import { ResumesController } from './resumes.controller';
import { ResumesService } from './resumes.service';

@Module({
  controllers: [ResumesController],
  providers: [ResumesService],
  // Exported because account deletion needs it: blobs live outside the
  // database, so the delete-cascade cannot reach them and `DELETE /me` has to
  // ask for them explicitly.
  exports: [ResumesService],
})
export class ResumesModule {}
