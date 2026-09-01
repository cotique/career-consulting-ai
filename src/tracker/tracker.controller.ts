import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { CreateApplicationDto, TransitionApplicationDto } from './tracker.dto';
import { TrackerService } from './tracker.service';

@ApiTags('applications')
@Controller('me/applications')
@UseGuards(AuthGuard)
export class TrackerController {
  constructor(private readonly tracker: TrackerService) {}

  @Post()
  @ApiOperation({ summary: 'Start tracking a vacancy' })
  async create(@CurrentUser() userId: string, @Body() body: CreateApplicationDto) {
    return this.tracker.create(userId, body);
  }

  @Get()
  @ApiQuery({ name: 'status', required: false, description: 'Filter to one status.' })
  @ApiOperation({ summary: 'List tracked applications, most recently updated first' })
  async list(@CurrentUser() userId: string, @Query('status') status?: string) {
    return this.tracker.list(userId, { status });
  }

  @Get(':id')
  @ApiOperation({ summary: 'One application, with its event timeline' })
  async get(@CurrentUser() userId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.tracker.get(userId, id);
  }

  @Post(':id/transition')
  @ApiOperation({
    summary: 'Move an application to a new status',
    description:
      'Writes an event either way. Reaching applied schedules a follow-up reminder in 14 days if nothing else happens first.',
  })
  async transition(
    @CurrentUser() userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: TransitionApplicationDto,
  ) {
    return this.tracker.transition(userId, id, body);
  }
}
