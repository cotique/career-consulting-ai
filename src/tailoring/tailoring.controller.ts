import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { TailoringService } from './tailoring.service';

@ApiTags('tailoring')
@Controller('me')
@UseGuards(AuthGuard)
export class TailoringController {
  constructor(private readonly tailoring: TailoringService) {}

  // A paid model call, capped like scoring and parsing: a schema retry pays twice.
  @Throttle({ default: { limit: 30, ttl: 3600_000 } })
  @Post('vacancies/:id/tailor')
  @ApiOperation({
    summary: 'Tailor your resume to a parsed posting',
    description:
      'Costs an LLM call. Rate-limited. Reorders bullets and skills by relevance to the posting and may reword a bullet to use the posting’s terms. Companies, titles, dates and skills are copied from your resume and cannot be changed, but a reworded bullet is only bounded, not proven true: every change is listed beside the result. Each call inserts a new draft version; nothing is approved until you approve it.',
  })
  async tailor(@CurrentUser() userId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.tailoring.tailorResume(userId, id);
  }

  @Get('tailored-documents/:id')
  @ApiOperation({ summary: 'Read a tailored document, with what changed against your resume' })
  async get(@CurrentUser() userId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.tailoring.getTailoredDocument(userId, id);
  }

  @Patch('tailored-documents/:id/approve')
  @HttpCode(200)
  @ApiOperation({ summary: 'Approve a tailored document after reading what changed' })
  async approve(@CurrentUser() userId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.tailoring.approve(userId, id);
  }
}
