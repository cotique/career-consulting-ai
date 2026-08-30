import { Controller, HttpCode, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { ScoringService } from './scoring.service';

@ApiTags('vacancies')
@Controller('me/vacancies')
@UseGuards(AuthGuard)
export class ScoringController {
  constructor(private readonly scoring: ScoringService) {}

  // A paid model call, same reasoning and the same cap as parsing: a schema
  // retry pays twice, and this is a call made once per posting in a sitting.
  @Throttle({ default: { limit: 30, ttl: 3600_000 } })
  @Post(':id/score')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Score a parsed posting against your profile and resume',
    description:
      'Costs an LLM call. Rate-limited. Requires the vacancy to be parsed, a saved profile, and an extracted resume. Each call inserts a new snapshot rather than overwriting the last one.',
  })
  async score(@CurrentUser() userId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.scoring.scoreVacancy(userId, id);
  }
}
