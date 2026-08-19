import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module';
import { DbModule } from './db/db.module';
import { LlmModule } from './llm/llm.module';
import { AuthModule } from './auth/auth.module';
import { HealthModule } from './health/health.module';
import { OnboardingModule } from './onboarding/onboarding.module';
import { RateLimitModule } from './rate-limit/rate-limit.module';
import { ResumesModule } from './resumes/resumes.module';
import { StorageModule } from './storage/storage.module';
import { IntakeModule } from './intake/intake.module';
import { ScoringModule } from './scoring/scoring.module';
import { TailoringModule } from './tailoring/tailoring.module';
import { MemoryModule } from './memory/memory.module';
import { TrackerModule } from './tracker/tracker.module';
import { SelfAuditModule } from './self-audit/self-audit.module';
import { WellbeingModule } from './wellbeing/wellbeing.module';

@Module({
  imports: [
    ConfigModule,
    DbModule,
    LlmModule,
    RateLimitModule,
    StorageModule,
    AuthModule,
    HealthModule,
    OnboardingModule,
    ResumesModule,
    IntakeModule,
    ScoringModule,
    TailoringModule,
    MemoryModule,
    TrackerModule,
    SelfAuditModule,
    WellbeingModule,
  ],
})
export class AppModule {}
