import { BadRequestException, Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import type { Pool } from 'pg';
import { PG_POOL } from '../db/db.module';
import { withUserContext } from '../db/user-context';
import * as schema from '../db/schema';
import { JOB_NAMES } from '../jobs/job-name';
import { JobQueueService } from '../jobs/job-queue.service';
import { EmbeddingService } from '../llm/embedding.service';
import { contentHashOf, renderResumeExtractionText, renderVacancyText } from './chunk-source';

interface ReindexJobPayload {
  userId: string;
}

type ResumeExtractionRow = typeof schema.resumeExtractions.$inferSelect;
type VacancyRow = typeof schema.vacancies.$inferSelect;

export interface SearchHit {
  sourceTable: 'resume_extraction' | 'vacancy';
  sourceId: string;
  content: string;
  score: number;
}

const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SEARCH_LIMIT = 50;

/** Vector literal format pgvector accepts, matching drizzle-orm's own PgVector.mapToDriverValue. */
function toVectorLiteral(vector: number[]): string {
  return JSON.stringify(vector);
}

@Injectable()
export class RetrievalService implements OnApplicationBootstrap {
  private readonly logger = new Logger(RetrievalService.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly jobQueue: JobQueueService,
    private readonly embeddings: EmbeddingService,
  ) {}

  /**
   * Retrieval is pg-boss's second real consumer, after the tracker (T21).
   * Registered once, here, for the app's lifetime — see tracker.service.ts's
   * own comment on why calling `registerHandler` twice against one queue is
   * a real, previously-hit race, not a hypothetical.
   *
   * `onApplicationBootstrap`, not `onModuleInit`: Nest only guarantees the
   * latter runs before *this module's own* dependencies finish, not before
   * every other module's — JobsModule happened to init first while nothing
   * else imported RetrievalModule, and stopped once chat (T19) did, since
   * that added a real edge to the module graph. `onApplicationBootstrap`
   * is the one hook Nest runs only after every module's `onModuleInit` has
   * completed, regardless of import shape — the actual guarantee this needs.
   */
  async onApplicationBootstrap(): Promise<void> {
    await this.jobQueue.registerHandler<ReindexJobPayload>(JOB_NAMES.RETRIEVAL_REINDEX, (job) =>
      this.runReindex(job.data.userId),
    );
  }

  /**
   * Manually triggered, per the standing rule that every LLM-calling action
   * runs at the caller's own request rather than as a side effect of an
   * unrelated write — nothing in intake/scoring/resumes/tracker enqueues
   * this on your behalf.
   */
  async reindex(userId: string): Promise<{ jobId: string | null }> {
    const jobId = await this.jobQueue.enqueue(JOB_NAMES.RETRIEVAL_REINDEX, { userId });
    return { jobId };
  }

  /** Embeds `query` (a paid call) and returns the closest chunks, scoped to the caller by RLS. */
  async search(userId: string, query: string, limit?: number): Promise<SearchHit[]> {
    const trimmed = query.trim();
    if (!trimmed) {
      throw new BadRequestException('query is empty.');
    }
    const boundedLimit = Math.min(Math.max(1, limit ?? DEFAULT_SEARCH_LIMIT), MAX_SEARCH_LIMIT);

    const { vector } = await this.embeddings.embed(userId, trimmed);
    const vectorLiteral = toVectorLiteral(vector);

    return withUserContext(this.pool, userId, async (db) => {
      const result = await db.execute(sql`
        SELECT * FROM (
          SELECT 'resume_extraction' AS source_table,
                 resume_extraction_id AS source_id,
                 content,
                 embedding <=> ${vectorLiteral}::vector AS distance
          FROM resume_extraction_chunks
          WHERE embedding IS NOT NULL
          UNION ALL
          SELECT 'vacancy' AS source_table,
                 vacancy_id AS source_id,
                 content,
                 embedding <=> ${vectorLiteral}::vector AS distance
          FROM vacancy_chunks
          WHERE embedding IS NOT NULL
        ) hits
        ORDER BY distance ASC
        LIMIT ${boundedLimit}
      `);

      return (
        result.rows as Array<{
          source_table: 'resume_extraction' | 'vacancy';
          source_id: string;
          content: string;
          distance: number;
        }>
      ).map((row) => ({
        sourceTable: row.source_table,
        sourceId: row.source_id,
        content: row.content,
        score: 1 - row.distance,
      }));
    });
  }

  private async runReindex(userId: string): Promise<void> {
    const extractions = await withUserContext(this.pool, userId, (db) =>
      db.select().from(schema.resumeExtractions).where(eq(schema.resumeExtractions.userId, userId)),
    );
    for (const extraction of extractions) {
      await this.upsertResumeExtractionChunk(userId, extraction);
    }

    const vacancyRows = await withUserContext(this.pool, userId, (db) =>
      db.select().from(schema.vacancies).where(eq(schema.vacancies.userId, userId)),
    );
    for (const vacancy of vacancyRows) {
      await this.upsertVacancyChunk(userId, vacancy);
    }

    this.logger.log(
      `Reindexed user ${userId}: ${extractions.length} resume extraction(s), ${vacancyRows.length} vacancy(ies) checked.`,
    );
  }

  /**
   * Each DB touch below is its own short transaction — deliberately not one
   * transaction wrapping the whole loop, the same reasoning `LlmService`
   * documents on itself: a paid provider call takes real time, and a pooled
   * connection held open across many of them in one loop is how the pool
   * dies under concurrency.
   *
   * That leaves the read-hash / embed / upsert sequence as three separate
   * transactions, so two concurrent reindexes for the same user (a
   * double-click) can both decide the same row needs re-embedding. Both
   * derive `content` from the same source row, so they converge on an
   * identical result and `onConflictDoUpdate` makes the write idempotent —
   * the worst case is one wasted paid call, never a corrupted chunk.
   */
  private async upsertResumeExtractionChunk(userId: string, extraction: ResumeExtractionRow): Promise<void> {
    const content = renderResumeExtractionText(extraction.structuredJson);
    const contentHash = contentHashOf(content);

    const existingHash = await withUserContext(this.pool, userId, async (db) => {
      const [existing] = await db
        .select({ contentHash: schema.resumeExtractionChunks.contentHash })
        .from(schema.resumeExtractionChunks)
        .where(eq(schema.resumeExtractionChunks.resumeExtractionId, extraction.id));
      return existing?.contentHash;
    });
    // The source row hasn't changed since the last reindex — skip the paid call.
    if (existingHash === contentHash) return;

    const { vector, model } = await this.embeddings.embed(userId, content);

    await withUserContext(this.pool, userId, (db) =>
      db
        .insert(schema.resumeExtractionChunks)
        .values({
          userId,
          resumeExtractionId: extraction.id,
          chunkIndex: 0,
          content,
          contentHash,
          embedding: vector,
          embeddingModel: model,
        })
        .onConflictDoUpdate({
          target: [schema.resumeExtractionChunks.resumeExtractionId, schema.resumeExtractionChunks.chunkIndex],
          set: { content, contentHash, embedding: vector, embeddingModel: model, updatedAt: new Date() },
        }),
    );
  }

  private async upsertVacancyChunk(userId: string, vacancy: VacancyRow): Promise<void> {
    const content = renderVacancyText(vacancy.rawText);
    const contentHash = contentHashOf(content);

    const existingHash = await withUserContext(this.pool, userId, async (db) => {
      const [existing] = await db
        .select({ contentHash: schema.vacancyChunks.contentHash })
        .from(schema.vacancyChunks)
        .where(eq(schema.vacancyChunks.vacancyId, vacancy.id));
      return existing?.contentHash;
    });
    if (existingHash === contentHash) return;

    const { vector, model } = await this.embeddings.embed(userId, content);

    await withUserContext(this.pool, userId, (db) =>
      db
        .insert(schema.vacancyChunks)
        .values({
          userId,
          vacancyId: vacancy.id,
          chunkIndex: 0,
          content,
          contentHash,
          embedding: vector,
          embeddingModel: model,
        })
        .onConflictDoUpdate({
          target: [schema.vacancyChunks.vacancyId, schema.vacancyChunks.chunkIndex],
          set: { content, contentHash, embedding: vector, embeddingModel: model, updatedAt: new Date() },
        }),
    );
  }
}
