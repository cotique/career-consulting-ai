import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { SearchDto } from './retrieval.dto';
import { RetrievalService } from './retrieval.service';

@ApiTags('retrieval')
@Controller('me/retrieval')
@UseGuards(AuthGuard)
export class RetrievalController {
  constructor(private readonly retrieval: RetrievalService) {}

  @Post('reindex')
  @ApiOperation({
    summary: 'Re-chunk and re-embed your resumes and vacancies',
    description:
      'Enqueues a background job. Skips anything unchanged since the last reindex — costs an embedding call only for what actually changed.',
  })
  async reindex(@CurrentUser() userId: string) {
    return this.retrieval.reindex(userId);
  }

  @Post('search')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Search your own resumes and vacancies by meaning',
    description: 'Costs one embedding call, for the query itself.',
  })
  async search(@CurrentUser() userId: string, @Body() body: SearchDto) {
    return this.retrieval.search(userId, body.query, body.limit);
  }
}
