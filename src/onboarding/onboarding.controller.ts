import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { OnboardingDto, ParsePreviewDto } from './onboarding.dto';
import { OnboardingService } from './onboarding.service';

@ApiTags('onboarding')
@Controller('onboarding')
@UseGuards(AuthGuard)
export class OnboardingController {
  constructor(private readonly onboarding: OnboardingService) {}

  @Get()
  @ApiOperation({ summary: 'Current onboarding state' })
  async get(@CurrentUser() userId: string) {
    return this.onboarding.getProfile(userId);
  }

  // Every call here spends real tokens, and a failed schema validation spends
  // them twice. The budget caps bound the damage after the money is gone; this
  // refuses earlier and for free.
  @Throttle({ default: { limit: 10, ttl: 3600_000 } })
  @Post('parse-preview')
  @ApiOperation({
    summary: 'Parse the free-text step into structured preferences',
    description:
      'Returns what the system understood WITHOUT saving it. Review the result, then send it back as `preferences` on POST /onboarding. Rate-limited: this call costs money.',
  })
  async parsePreview(@CurrentUser() userId: string, @Body() body: ParsePreviewDto) {
    const preferences = await this.onboarding.parsePreferences(userId, body.freeText);
    return { preferences, saved: false };
  }

  @Post()
  @ApiOperation({
    summary: 'Save onboarding answers',
    description:
      'Every field is optional — submit one wizard step at a time. Omitted fields keep their current value.',
  })
  async save(@CurrentUser() userId: string, @Body() body: OnboardingDto) {
    return this.onboarding.saveProfile(userId, body);
  }
}
