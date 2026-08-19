import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { Pool } from 'pg';
import { z } from 'zod';
import { PG_POOL } from '../db/db.module';
import { withUserContext } from '../db/user-context';
import * as schema from '../db/schema';
import { httpErrorFor } from '../llm/llm-http';
import { LlmService } from '../llm/llm.service';
import { ONBOARDING_FREE_TEXT } from '../llm/templates';
import {
  isEuropeanCountryCode,
  isValidTimeOfDay,
  isValidTimezone,
  isValidUiLanguage,
} from './markets';
import type { OnboardingDto } from './onboarding.dto';

/**
 * The shape the parse template promises. Unknown keys are stripped rather than
 * rejected — a model volunteering an extra field is not worth a paid retry,
 * but a wrong *type* is, since that's what would corrupt the stored profile.
 */
const PreferencesSchema = z.object({
  industries: z.array(z.string()).optional(),
  companyStages: z.array(z.string()).optional(),
  workMode: z.enum(['remote', 'hybrid', 'onsite']).nullish(),
  dealBreakers: z.array(z.string()).optional(),
  priorities: z.array(z.string()).optional(),
});

@Injectable()
export class OnboardingService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly llm: LlmService,
  ) {}

  async getProfile(userId: string) {
    return withUserContext(this.pool, userId, async (db) => {
      const [profile] = await db
        .select()
        .from(schema.userProfiles)
        .where(eq(schema.userProfiles.userId, userId));
      return profile ?? null;
    });
  }

  /**
   * Parses free text into structured preferences and hands the result back for
   * review — it is deliberately NOT saved here. The user confirms (or edits)
   * what the system understood before it becomes their profile; showing the
   * interpretation rather than quietly storing an inference is the same
   * honesty-calibration principle the product applies to its own output.
   */
  async parsePreferences(userId: string, freeText: string): Promise<Record<string, unknown>> {
    const trimmed = freeText?.trim();
    if (!trimmed) {
      throw new BadRequestException('freeText is empty.');
    }

    // Read first, in its own short transaction; the profile is consulted only
    // for the conversation language. The model call then happens outside any
    // transaction of ours, so a failure cannot roll back the usage rows that
    // record what it cost — see the note on LlmService.
    const [profile] = await withUserContext(this.pool, userId, (db) =>
      db
        .select({ uiLanguage: schema.userProfiles.uiLanguage })
        .from(schema.userProfiles)
        .where(eq(schema.userProfiles.userId, userId)),
    );

    try {
      const { data } = await this.llm.completeStructured(
        {
          template: 'onboarding_parse',
          userId,
          // The user's own words are untrusted input — the LLM layer renders
          // them inside data delimiters, never as instructions.
          untrusted: { [ONBOARDING_FREE_TEXT]: trimmed },
          params: { language: profile?.uiLanguage ?? undefined },
        },
        PreferencesSchema,
      );
      return data;
    } catch (err) {
      // The layer already retried once with the validation issues fed back. A
      // second failure is not something the user can fix by waiting, so say so
      // rather than surfacing a 500 — and the same goes for a truncated answer
      // or a tripped spend guard, which is why the mapping is shared.
      throw httpErrorFor(
        err,
        'Could not read that as structured preferences. Try rephrasing it more plainly.',
      );
    }
  }

  async saveProfile(userId: string, dto: OnboardingDto) {
    this.validate(dto);

    return withUserContext(this.pool, userId, async (db) => {
      if (dto.name !== undefined) {
        await db.update(schema.users).set({ name: dto.name }).where(eq(schema.users.id, userId));
      }

      // Only the keys present in the request are touched, so a client can
      // submit one wizard step at a time without clearing the others.
      const patch = {
        ...(dto.targetRoles !== undefined && { targetRoles: dto.targetRoles }),
        ...(dto.locations !== undefined && { locations: dto.locations }),
        ...(dto.uiLanguage !== undefined && { uiLanguage: dto.uiLanguage }),
        ...(dto.targetMarkets !== undefined && { targetMarkets: dto.targetMarkets }),
        ...(dto.timezone !== undefined && { timezone: dto.timezone }),
        ...(dto.preferredNotificationTime !== undefined && {
          preferredNotificationTime: dto.preferredNotificationTime,
        }),
        ...(dto.preferences !== undefined && { preferences: dto.preferences }),
      };

      const [saved] = await db
        .insert(schema.userProfiles)
        .values({ userId, ...patch })
        .onConflictDoUpdate({ target: schema.userProfiles.userId, set: patch })
        .returning();

      return saved;
    });
  }

  private validate(dto: OnboardingDto): void {
    for (const market of dto.targetMarkets ?? []) {
      if (!market.countryCode) {
        throw new BadRequestException('Each target market needs a countryCode.');
      }
      if (!isEuropeanCountryCode(market.countryCode)) {
        throw new BadRequestException(
          `Market "${market.countryCode}" is outside Europe. Only European markets are supported at launch — the market list widens in a later release.`,
        );
      }
    }

    if (dto.uiLanguage !== undefined && !isValidUiLanguage(dto.uiLanguage)) {
      throw new BadRequestException(
        `"${dto.uiLanguage}" is not a two-letter ISO 639-1 language code (e.g. "en", "pl").`,
      );
    }

    if (dto.timezone !== undefined && !isValidTimezone(dto.timezone)) {
      throw new BadRequestException(
        `"${dto.timezone}" is not a valid IANA timezone (e.g. "Europe/Warsaw").`,
      );
    }

    if (
      dto.preferredNotificationTime !== undefined &&
      !isValidTimeOfDay(dto.preferredNotificationTime)
    ) {
      throw new BadRequestException('preferredNotificationTime must be HH:MM in 24-hour form.');
    }
  }
}
