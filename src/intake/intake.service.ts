import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import type { Pool } from 'pg';
import { PG_POOL } from '../db/db.module';
import { withUserContext } from '../db/user-context';
import * as schema from '../db/schema';
import { httpErrorFor } from '../llm/llm-http';
import { LlmService } from '../llm/llm.service';
import { VACANCY_TEXT } from '../llm/templates';
import type { PasteVacancyDto } from './intake.dto';
import { blockersFor } from './market-scope';
import { MAX_PASTE_CHARS, hashOf } from './paste';
import { VacancyStructureSchema, countryCodeOf, hasParsedSubstance } from './vacancy-schema';

/**
 * One message for every way a posting can fail to become a structure — a schema
 * mismatch, a truncated answer, an answer with nothing in it. They differ for
 * us and are logged separately; to the person who pasted the text they are the
 * same fact, and the useful half is what to do next.
 */
const UNREADABLE_VACANCY =
  'Could not read that as a job posting. If the paste came out as navigation and cookie banners with the description buried inside, pasting just the description usually works.';

type VacancyRow = typeof schema.vacancies.$inferSelect;

@Injectable()
export class IntakeService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly llm: LlmService,
  ) {}

  /**
   * Stores a pasted posting (FR6). No model call — this is free, and parsing is
   * a separate, paid, rate-limited step.
   *
   * An exact repeat is **routed, not refused**: the caller gets the vacancy that
   * already holds this text, flagged as existing. A unique constraint would have
   * turned the ordinary act of pasting something twice into an error a client
   * has to interpret, and the row it collided with is the thing the caller
   * wanted anyway.
   */
  async paste(userId: string, dto: PasteVacancyDto) {
    const rawText = dto.rawText?.trim();
    if (!rawText) {
      throw new BadRequestException('rawText is empty.');
    }
    if (rawText.length > MAX_PASTE_CHARS) {
      throw new BadRequestException(
        `That paste is ${rawText.length} characters; the limit is ${MAX_PASTE_CHARS}. Paste the description rather than the whole page.`,
      );
    }
    const sourceUrl = dto.sourceUrl?.trim() || null;
    if (sourceUrl && !/^https?:\/\//i.test(sourceUrl)) {
      throw new BadRequestException('sourceUrl must be an http(s) URL.');
    }

    const rawTextHash = hashOf(rawText);

    return withUserContext(this.pool, userId, async (db) => {
      const [existing] = await db
        .select()
        .from(schema.vacancies)
        .where(
          and(eq(schema.vacancies.userId, userId), eq(schema.vacancies.rawTextHash, rawTextHash)),
        )
        .orderBy(schema.vacancies.createdAt)
        .limit(1);

      if (existing) {
        return { ...this.view(existing), duplicate: true as const };
      }

      const [row] = await db
        .insert(schema.vacancies)
        .values({ userId, sourceType: 'paste', sourceUrl, rawText, rawTextHash })
        .returning();

      return { ...this.view(row), duplicate: false as const };
    });
  }

  /**
   * The user's vacancies, newest first.
   *
   * Blocked ones are absent by default and returned by `all` — absent from a
   * list, never absent from the database. Filtered here rather than in SQL
   * because the supported-market list lives in application code by decision
   * (widening it is a code change, not a migration), and encoding it into a
   * query would put a second copy of it somewhere that never gets reviewed.
   */
  async list(userId: string, { all = false }: { all?: boolean } = {}) {
    const rows = await withUserContext(this.pool, userId, (db) =>
      db
        .select()
        .from(schema.vacancies)
        .where(eq(schema.vacancies.userId, userId))
        .orderBy(desc(schema.vacancies.createdAt)),
    );

    const views = rows.map((row) => this.view(row));
    return all ? views : views.filter((v) => v.blockers.length === 0);
  }

  /** One vacancy, with the text as pasted and whatever structure it has. */
  async get(userId: string, vacancyId: string) {
    const row = await this.load(userId, vacancyId);
    return { ...this.view(row), rawText: row.rawText, structured: row.structuredJson };
  }

  /**
   * Parses a stored posting into structure (FR6).
   *
   * Takes identifiers only, no content — a job handler's exact signature and the
   * payload convention it must obey, so that T20 wraps this rather than
   * rewriting it. It runs synchronously today because someone is waiting for the
   * answer and no queue exists yet.
   *
   * Re-parsing is allowed and overwrites: after a prompt revision, the point is
   * to get the better structure. `parse_prompt_version` records which prompt
   * produced what is stored, so the two are never compared under one label.
   */
  async parseVacancy(userId: string, vacancyId: string) {
    const vacancy = await this.load(userId, vacancyId);

    // Deliberately outside any transaction of ours. The LLM layer opens its own
    // short ones for the spend guards and the usage log, which is what keeps the
    // record of money already spent from being rolled back by a failure here.
    let parsed;
    try {
      parsed = await this.llm.completeStructured(
        {
          template: 'vacancy_parse',
          userId,
          // The posting is untrusted input — text from outside the system, and
          // the one place in this flow where an instruction could be smuggled
          // in. The rendering layer wraps it in data delimiters.
          untrusted: { [VACANCY_TEXT]: vacancy.rawText },
        },
        VacancyStructureSchema,
      );
    } catch (err) {
      throw httpErrorFor(err, UNREADABLE_VACANCY);
    }

    // Every field in the schema is optional or defaulted, so `{}` validates and
    // arrives here as a job with no title at no company. Storing it would let
    // scoring run against an empty description and return a number for it.
    if (!hasParsedSubstance(parsed.data)) {
      throw new BadRequestException(UNREADABLE_VACANCY);
    }

    const countryCode = countryCodeOf(parsed.data);

    return withUserContext(this.pool, userId, async (db) => {
      const [saved] = await db
        .update(schema.vacancies)
        .set({
          structuredJson: parsed.data,
          parsePromptVersion: parsed.promptVersion,
          // Denormalised out of the structure so a list does not have to read
          // and reach into every JSON blob to say what a row is.
          title: parsed.data.title ?? null,
          companyName: parsed.data.companyName ?? null,
          countryCode,
        })
        .where(eq(schema.vacancies.id, vacancyId))
        .returning();

      return { ...this.view(saved), structured: saved.structuredJson };
    });
  }

  private async load(userId: string, vacancyId: string): Promise<VacancyRow> {
    const row = await withUserContext(this.pool, userId, async (db) => {
      const [found] = await db
        .select()
        .from(schema.vacancies)
        .where(eq(schema.vacancies.id, vacancyId));
      return found;
    });

    // RLS already hides other users' rows, so "not visible" and "does not
    // exist" arrive here as the same thing — and are answered the same way,
    // which is what stops this endpoint from confirming that someone else's
    // vacancy id exists.
    if (!row) throw new NotFoundException('No such vacancy.');
    return row;
  }

  /**
   * The row as callers see it. `parse.state` is part of the resource rather
   * than something a client infers from a null: a pasted posting with no
   * structure yet is an ordinary condition, and a list that left it out would
   * present an unparsed vacancy as ready to score.
   */
  private view(row: VacancyRow) {
    return {
      id: row.id,
      sourceType: row.sourceType,
      sourceUrl: row.sourceUrl,
      title: row.title,
      companyName: row.companyName,
      countryCode: row.countryCode,
      createdAt: row.createdAt,
      parse: row.structuredJson
        ? { state: 'parsed' as const, promptVersion: row.parsePromptVersion }
        : { state: 'not_parsed' as const },
      blockers: blockersFor(row.countryCode),
    };
  }
}
