import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { PasteVacancyDto } from './intake.dto';
import { IntakeService } from './intake.service';

@ApiTags('vacancies')
@Controller('me/vacancies')
@UseGuards(AuthGuard)
export class IntakeController {
  constructor(private readonly intake: IntakeService) {}

  @Post()
  @ApiOperation({
    summary: 'Paste a job posting',
    description:
      'Stores the text as given. Free — parsing is a separate call. Pasting the same posting twice returns the vacancy that already holds it, with 200 instead of 201.',
  })
  async paste(
    @CurrentUser() userId: string,
    @Body() body: PasteVacancyDto,
    // Passthrough so the status can say which of the two things happened.
    // Answering 201 for a paste that created nothing would be a small lie that
    // a client caching on it would act upon.
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.intake.paste(userId, body);
    res.status(result.duplicate ? 200 : 201);
    return result;
  }

  @Get()
  @ApiQuery({
    name: 'all',
    required: false,
    description:
      'Include vacancies with a blocker. They are stored and readable either way — the default list just leaves them out.',
  })
  @ApiOperation({ summary: 'List vacancies, newest first' })
  async list(@CurrentUser() userId: string, @Query('all') all?: string) {
    return this.intake.list(userId, { all: all === 'true' });
  }

  @Get(':id')
  @ApiOperation({
    summary: 'One vacancy, with its text and structure',
    description: 'Returns the posting as pasted alongside whatever has been parsed out of it.',
  })
  async get(@CurrentUser() userId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.intake.get(userId, id);
  }

  // A paid model call, and a schema retry pays twice — the same reason the
  // resume extraction and the onboarding preview are capped. Looser than those:
  // this is the one call a person makes repeatedly in a sitting, once per
  // posting they found worth keeping.
  @Throttle({ default: { limit: 30, ttl: 3600_000 } })
  @Post(':id/parse')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Parse a stored posting into structure',
    description:
      'Costs an LLM call. Rate-limited. Calling it again re-parses and overwrites — which is the point after a prompt revision.',
  })
  async parse(@CurrentUser() userId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.intake.parseVacancy(userId, id);
  }
}
