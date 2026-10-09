import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, max } from 'drizzle-orm';
import type { Pool } from 'pg';
import { PG_POOL } from '../db/db.module';
import * as schema from '../db/schema';
import { withUserContext } from '../db/user-context';
import { VacancyStructureSchema } from '../intake/vacancy-schema';
import { httpErrorFor } from '../llm/llm-http';
import { LlmService } from '../llm/llm.service';
import { RESUME_TAILOR_RESUME, RESUME_TAILOR_VACANCY } from '../llm/templates';
import { ResumeStructureSchema } from '../resumes/resume-schema';
import { applyTailoringPlan, indexedResumeForPrompt, TailoringPlanError } from './apply-plan';
import { renderResumeMarkdown } from './render-resume';
import { TailoringPlanSchema } from './tailor-schema';

const UNTAILORABLE =
  'Could not tailor your resume to that posting — the model did not return a usable answer.';
const PLAN_NOT_APPLICABLE =
  'Could not tailor your resume to that posting — the model returned a plan that does not fit your resume.';

type TailoredDocumentRow = typeof schema.tailoredDocuments.$inferSelect;

@Injectable()
export class TailoringService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly llm: LlmService,
  ) {}

  /**
   * Tailors the user's active resume to a stored, already-parsed vacancy (FR25).
   *
   * Synchronous for the same reason scoring is: one short call someone is
   * waiting on. The model returns a plan (an order and a few reworded bullets)
   * and `applyTailoringPlan` builds the result from the *original* resume, so
   * nothing the model says can change a company, a date or a skill. Each run
   * inserts a new draft version; nothing is overwritten and nothing is
   * approved until the user says so.
   */
  async tailorResume(userId: string, vacancyId: string) {
    const { vacancy, extraction, resumeId } = await withUserContext(this.pool, userId, async (db) => {
      const [vacancyRow] = await db
        .select()
        .from(schema.vacancies)
        .where(eq(schema.vacancies.id, vacancyId));

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

      return { vacancy: vacancyRow, extraction: extractionRow, resumeId: activeResume?.id };
    });

    // Not visible and does not exist are the same answer, as in scoring: this
    // endpoint must not confirm that someone else's vacancy id exists.
    if (!vacancy) throw new NotFoundException('No such vacancy.');
    if (!vacancy.structuredJson) {
      throw new BadRequestException('This vacancy has not been parsed yet — parse it before tailoring.');
    }
    if (!extraction || !resumeId) {
      throw new ConflictException(
        'No extracted resume yet — upload and extract a resume before tailoring.',
      );
    }

    const source = ResumeStructureSchema.parse(extraction.structuredJson);
    const vacancyStructure = VacancyStructureSchema.parse(vacancy.structuredJson);

    let result;
    try {
      result = await this.llm.completeStructured(
        {
          template: 'resume_tailor',
          userId,
          untrusted: {
            [RESUME_TAILOR_RESUME]: indexedResumeForPrompt(source),
            [RESUME_TAILOR_VACANCY]: vacancyStructure,
          },
        },
        TailoringPlanSchema,
      );
    } catch (err) {
      throw httpErrorFor(err, UNTAILORABLE);
    }

    let tailored;
    try {
      tailored = applyTailoringPlan(source, vacancyStructure, result.data);
    } catch (err) {
      // The call has already been paid for and recorded by the layer; a plan
      // that cannot be applied is not retried, because the same input would
      // produce the same misreading.
      if (err instanceof TailoringPlanError) throw new BadRequestException(PLAN_NOT_APPLICABLE);
      throw err;
    }

    return withUserContext(this.pool, userId, async (db) => {
      const [latest] = await db
        .select({ version: max(schema.tailoredDocuments.version) })
        .from(schema.tailoredDocuments)
        .where(
          and(
            eq(schema.tailoredDocuments.vacancyId, vacancyId),
            eq(schema.tailoredDocuments.resumeId, resumeId),
            eq(schema.tailoredDocuments.docType, 'resume'),
          ),
        );

      const [saved] = await db
        .insert(schema.tailoredDocuments)
        .values({
          userId,
          vacancyId,
          resumeId,
          docType: 'resume',
          content: renderResumeMarkdown(tailored.structure),
          structure: tailored.structure,
          changes: tailored.changes,
          version: (latest?.version ?? 0) + 1,
          modelUsed: result.model,
          promptVersion: result.promptVersion,
        })
        .returning();

      return this.view(saved);
    });
  }

  async getTailoredDocument(userId: string, id: string) {
    const row = await withUserContext(this.pool, userId, async (db) => {
      const [found] = await db
        .select()
        .from(schema.tailoredDocuments)
        .where(eq(schema.tailoredDocuments.id, id));
      return found;
    });
    if (!row) throw new NotFoundException('No such tailored document.');
    return this.view(row);
  }

  /** Idempotent: approving an approved document answers the same way. */
  async approve(userId: string, id: string) {
    const row = await withUserContext(this.pool, userId, async (db) => {
      const [updated] = await db
        .update(schema.tailoredDocuments)
        .set({ state: 'approved' })
        .where(eq(schema.tailoredDocuments.id, id))
        .returning();
      return updated;
    });
    if (!row) throw new NotFoundException('No such tailored document.');
    return this.view(row);
  }

  private view(row: TailoredDocumentRow) {
    return {
      id: row.id,
      vacancyId: row.vacancyId,
      resumeId: row.resumeId,
      docType: row.docType,
      version: row.version,
      state: row.state,
      createdBy: row.createdBy,
      modelUsed: row.modelUsed,
      promptVersion: row.promptVersion,
      createdAt: row.createdAt,
      content: row.content,
      structure: row.structure,
      changes: row.changes,
    };
  }
}
