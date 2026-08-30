import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import type { Pool } from 'pg';
import { PG_POOL } from '../db/db.module';
import { withUserContext } from '../db/user-context';
import * as schema from '../db/schema';
import type { VacancyBlocker } from '../intake/market-scope';
import { httpErrorFor } from '../llm/llm-http';
import { LlmService } from '../llm/llm.service';
import { missingScoringInput, scoreAgainstProfile } from './scoring-core';

const UNSCORABLE_VACANCY =
  'Could not score that posting against your profile — the model did not return a usable answer.';

const MISSING_INPUT_MESSAGE: Record<'missing_profile' | 'missing_resume', string> = {
  missing_profile: 'No profile yet — finish onboarding before scoring a vacancy.',
  missing_resume: 'No extracted resume yet — upload and extract a resume before scoring a vacancy.',
};

type VacancyScoreRow = typeof schema.vacancyScores.$inferSelect;

interface Breakdown {
  presentable: string[];
  tradeoff: { fits: string[]; doesNotFit: string[] };
  blockers: VacancyBlocker[];
}

@Injectable()
export class ScoringService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly llm: LlmService,
  ) {}

  /**
   * Scores a stored, already-parsed vacancy against the user's profile and
   * active resume (FR7).
   *
   * Takes identifiers only, no content — same job-handler shape as
   * `IntakeService.parseVacancy`, so T20 wraps this rather than rewriting it.
   * Re-scoring is allowed and inserts a new row rather than overwriting: a
   * score is a snapshot (see TRADEOFFS.md), and keeping every one is what
   * would let self-audit compare them later.
   */
  async scoreVacancy(userId: string, vacancyId: string) {
    const { vacancy, profile, extraction } = await withUserContext(this.pool, userId, async (db) => {
      const [vacancyRow] = await db
        .select()
        .from(schema.vacancies)
        .where(eq(schema.vacancies.id, vacancyId));

      const [profileRow] = await db
        .select()
        .from(schema.userProfiles)
        .where(eq(schema.userProfiles.userId, userId));

      const [activeResume] = await db
        .select()
        .from(schema.resumes)
        .where(and(eq(schema.resumes.userId, userId), eq(schema.resumes.isActive, true)));

      const extractionRow = activeResume
        ? (
            await db
              .select()
              .from(schema.resumeExtractions)
              .where(eq(schema.resumeExtractions.resumeId, activeResume.id))
              .orderBy(desc(schema.resumeExtractions.extractedAt))
              .limit(1)
          )[0]
        : undefined;

      return { vacancy: vacancyRow, profile: profileRow, extraction: extractionRow };
    });

    // RLS already hides other users' rows, so "not visible" and "does not
    // exist" arrive here as the same thing — and are answered the same way,
    // which is what stops this endpoint from confirming that someone else's
    // vacancy id exists.
    if (!vacancy) throw new NotFoundException('No such vacancy.');
    if (!vacancy.structuredJson) {
      throw new BadRequestException('This vacancy has not been parsed yet — parse it before scoring.');
    }

    const missing = missingScoringInput(profile, extraction);
    if (missing) {
      throw new ConflictException(MISSING_INPUT_MESSAGE[missing]);
    }

    let result;
    try {
      result = await scoreAgainstProfile(this.llm, {
        userId,
        profile: {
          targetRoles: profile!.targetRoles,
          locations: profile!.locations,
          preferences: profile!.preferences,
          targetMarkets: profile!.targetMarkets,
        },
        extraction: extraction!.structuredJson as never,
        vacancy: { structured: vacancy.structuredJson as never, countryCode: vacancy.countryCode },
      });
    } catch (err) {
      throw httpErrorFor(err, UNSCORABLE_VACANCY);
    }

    const breakdown: Breakdown = {
      presentable: result.showable,
      tradeoff: result.tradeoff,
      blockers: result.blockers,
    };

    return withUserContext(this.pool, userId, async (db) => {
      const [saved] = await db
        .insert(schema.vacancyScores)
        .values({
          userId,
          vacancyId,
          score: result.score.toFixed(4),
          modelUsed: result.modelUsed,
          promptVersion: result.promptVersion,
          breakdown,
        })
        .returning();

      return this.view(saved);
    });
  }

  private view(row: VacancyScoreRow) {
    const breakdown = (row.breakdown ?? {}) as Partial<Breakdown>;
    return {
      id: row.id,
      vacancyId: row.vacancyId,
      score: Number(row.score),
      promptVersion: row.promptVersion,
      createdAt: row.createdAt,
      presentable: breakdown.presentable ?? [],
      tradeoff: breakdown.tradeoff ?? { fits: [], doesNotFit: [] },
      blockers: breakdown.blockers ?? [],
    };
  }
}
