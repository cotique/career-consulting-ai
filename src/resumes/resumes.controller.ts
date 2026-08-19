import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { MAX_UPLOAD_BYTES } from './extract-text';
import { ResumesService } from './resumes.service';

@ApiTags('resumes')
@Controller('me/resumes')
@UseGuards(AuthGuard)
export class ResumesController {
  constructor(private readonly resumes: ResumesService) {}

  @Post()
  // Held in memory rather than spooled to disk: the file is bounded to 5 MB and
  // goes straight to blob storage, so a temp file would be one more copy of
  // someone's CV lying around a filesystem for no benefit. The limit is set here
  // too, so multer refuses an oversized upload before it is fully buffered.
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES } }))
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: { file: { type: 'string', format: 'binary' } },
      required: ['file'],
    },
  })
  @ApiOperation({
    summary: 'Upload a resume',
    description:
      'PDF, .docx or plain text, up to 5 MB. The new resume becomes the active one and any previous resume is deactivated.',
  })
  async upload(@CurrentUser() userId: string, @UploadedFile() file: Express.Multer.File) {
    return this.resumes.upload(userId, file);
  }

  @Get()
  @ApiOperation({
    summary: 'List resumes with their extraction state',
    description:
      'Includes whether each resume has been extracted yet — an uploaded file without a structure is a normal state, not an error.',
  })
  async list(@CurrentUser() userId: string) {
    return this.resumes.list(userId);
  }

  @Get(':id/content')
  @ApiOperation({
    summary: 'Download the stored file',
    description: 'Streamed through the API under your session — there are no public or signed URLs.',
  })
  async content(
    @CurrentUser() userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Res() res: Response,
  ): Promise<void> {
    const { buffer, mimeType } = await this.resumes.content(userId, id);
    res.setHeader('Content-Type', mimeType);
    // Attachment, not inline: a PDF rendered in the browser from our own origin
    // is a needless script-execution surface for a file we did not author.
    res.setHeader('Content-Disposition', `attachment; filename="resume-${id}"`);
    res.send(buffer);
  }

  // Each extraction is a paid LLM call over the largest document in the system,
  // and a schema retry pays twice. Tighter than the global limit for the same
  // reason the onboarding preview is.
  @Throttle({ default: { limit: 10, ttl: 3600_000 } })
  @Post(':id/extract')
  @ApiOperation({
    summary: 'Extract the structure of a stored resume',
    description: 'Costs an LLM call. Rate-limited.',
  })
  async extract(@CurrentUser() userId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.resumes.extractResume(userId, id);
  }
}
