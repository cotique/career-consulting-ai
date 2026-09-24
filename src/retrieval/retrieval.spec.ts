import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../app.module';
import { SESSION_COOKIE, SessionService } from '../auth/session.service';
import { createAdminDb } from '../db/test-db';
import * as schema from '../db/schema';
import { AnthropicProvider } from '../llm/providers/anthropic.provider';
import { FakeEmbeddingProvider } from '../llm/providers/fake-embedding.provider';
import { OpenAiEmbeddingProvider } from '../llm/providers/openai-embedding.provider';
import { FakeProvider } from '../llm/providers/fake.provider';
import type {
  LlmProvider,
  ProviderCompletionParams,
  ProviderCompletionResult,
} from '../llm/providers/provider.interface';

/**
 * Retrieval infrastructure end to end: real HTTP through the whole stack,
 * real Postgres, the real pg-boss queue `RetrievalModule` registers a
 * handler against — no test here mocks `JobQueueService`. Both providers
 * (Anthropic completion, OpenAI embedding) are fakes: nothing here spends
 * real money against a real provider.
 */
const { db: adminDb, pool: adminPool } = createAdminDb();

const USER_A = 'a9a9a9a9-0000-4000-8000-00000000a9a9';
const USER_B = 'b9b9b9b9-0000-4000-8000-00000000b9b9';

let app: INestApplication;
let sessions: SessionService;
let fakeEmbedding: FakeEmbeddingProvider;

const fakeCompletion = new FakeProvider();
const delegatingCompletionProvider: LlmProvider = {
  complete: (params: ProviderCompletionParams): Promise<ProviderCompletionResult> =>
    fakeCompletion.complete(params),
};

const RESUME_STRUCTURED = { name: 'Jane Doe', headline: 'Backend Engineer' };

async function sessionCookieFor(userId: string): Promise<string> {
  const captured: string[] = [];
  const fakeRes = {
    cookie(name: string, value: string) {
      captured.push(`${name}=${value}`);
      return this;
    },
  };
  await sessions.issue(fakeRes as never, userId);
  return captured.find((c) => c.startsWith(`${SESSION_COOKIE}=`))!;
}

function pasteVacancy(cookie: string, rawText = 'Backend Engineer role at Acme, remote.') {
  return request(app.getHttpServer()).post('/me/vacancies').set('Cookie', cookie).send({ rawText });
}

/** Seeds a resume + its extraction directly — retrieval doesn't care how the extraction got there. */
async function seedResumeExtraction(userId: string, structuredJson: unknown = RESUME_STRUCTURED) {
  const [resume] = await adminDb
    .insert(schema.resumes)
    .values({ userId, blobStoragePath: `${userId}/resume.pdf`, mimeType: 'application/pdf' })
    .returning();
  const [extraction] = await adminDb
    .insert(schema.resumeExtractions)
    .values({ userId, resumeId: resume.id, structuredJson, modelUsed: 'test-model' })
    .returning();
  return extraction;
}

function reindex(cookie: string) {
  return request(app.getHttpServer()).post('/me/retrieval/reindex').set('Cookie', cookie);
}

function search(cookie: string, query: string, limit?: number) {
  return request(app.getHttpServer())
    .post('/me/retrieval/search')
    .set('Cookie', cookie)
    .send({ query, ...(limit ? { limit } : {}) });
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 14000, intervalMs = 100): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Condition not met within ${timeoutMs}ms`);
}

async function jobCompleted(jobId: string | null): Promise<boolean> {
  if (!jobId) return false;
  const rows = await adminDb.execute(sql`SELECT state FROM pgboss.job WHERE id = ${jobId}`);
  const row = rows.rows[0] as { state: string } | undefined;
  return row?.state === 'completed';
}

async function resumeExtractionChunksFor(userId: string) {
  return adminDb
    .select()
    .from(schema.resumeExtractionChunks)
    .where(eq(schema.resumeExtractionChunks.userId, userId));
}

async function vacancyChunksFor(userId: string) {
  return adminDb.select().from(schema.vacancyChunks).where(eq(schema.vacancyChunks.userId, userId));
}

async function embeddingUsageRows(userId: string) {
  return adminDb
    .select()
    .from(schema.llmUsageLogs)
    .where(and(eq(schema.llmUsageLogs.userId, userId), eq(schema.llmUsageLogs.taskType, 'retrieval_embedding')));
}

beforeAll(async () => {
  fakeEmbedding = new FakeEmbeddingProvider();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(AnthropicProvider)
    .useValue(delegatingCompletionProvider)
    .overrideProvider(OpenAiEmbeddingProvider)
    .useValue(fakeEmbedding)
    .compile();

  app = moduleRef.createNestApplication();
  app.use(cookieParser());
  await app.init();
  sessions = app.get(SessionService);
});

afterAll(async () => {
  for (const userId of [USER_A, USER_B]) {
    await adminDb.delete(schema.users).where(eq(schema.users.id, userId));
  }
  await app?.close();
  await adminPool.end();
});

beforeEach(async () => {
  for (const userId of [USER_A, USER_B]) {
    await adminDb.delete(schema.users).where(eq(schema.users.id, userId));
  }
  await adminDb.insert(schema.users).values([
    { id: USER_A, name: 'User A' },
    { id: USER_B, name: 'User B' },
  ]);
});

describe('reindexing (FR23)', () => {
  // Explicit timeouts below, matching T20/T21's own job-polling tests:
  // pg-boss's poll interval means a job can take a couple of seconds to
  // start, and vitest's 5s default test timeout leaves little margin over
  // this file's own 8s `waitFor` ceiling.
  it('chunks and embeds resume extractions and vacancies, skipping nothing unchanged', async () => {
    const cookie = await sessionCookieFor(USER_A);
    await seedResumeExtraction(USER_A);
    await pasteVacancy(cookie, 'Senior Backend Engineer, Acme, remote-friendly.');

    const { body } = await reindex(cookie).expect(201);
    await waitFor(() => jobCompleted(body.jobId));

    const resumeChunks = await resumeExtractionChunksFor(USER_A);
    const vacancyChunks = await vacancyChunksFor(USER_A);
    expect(resumeChunks).toHaveLength(1);
    expect(vacancyChunks).toHaveLength(1);
    expect(resumeChunks[0].content).toBe(JSON.stringify(RESUME_STRUCTURED));
    expect(resumeChunks[0].embeddingModel).toBe('text-embedding-3-small');
    expect(vacancyChunks[0].content).toContain('Senior Backend Engineer');
  }, 30000);

  it('a second reindex with nothing changed makes zero new embedding calls', async () => {
    const cookie = await sessionCookieFor(USER_A);
    await seedResumeExtraction(USER_A);
    await pasteVacancy(cookie);

    const first = await reindex(cookie).expect(201);
    await waitFor(() => jobCompleted(first.body.jobId));
    const afterFirst = (await embeddingUsageRows(USER_A)).length;
    expect(afterFirst).toBe(2); // one resume extraction + one vacancy

    const second = await reindex(cookie).expect(201);
    await waitFor(() => jobCompleted(second.body.jobId));
    expect((await embeddingUsageRows(USER_A)).length).toBe(afterFirst);
  }, 30000);

  it('re-embeds a source row once its content actually changes', async () => {
    const cookie = await sessionCookieFor(USER_A);
    const { body: vacancy } = await pasteVacancy(cookie, 'Original posting text.').expect(201);

    const first = await reindex(cookie).expect(201);
    await waitFor(() => jobCompleted(first.body.jobId));
    const [chunkBefore] = await vacancyChunksFor(USER_A);

    await adminDb
      .update(schema.vacancies)
      .set({ rawText: 'Completely different posting text now.' })
      .where(eq(schema.vacancies.id, vacancy.id));

    const second = await reindex(cookie).expect(201);
    await waitFor(() => jobCompleted(second.body.jobId));
    const [chunkAfter] = await vacancyChunksFor(USER_A);

    expect(chunkAfter.contentHash).not.toBe(chunkBefore.contentHash);
    expect(chunkAfter.content).toContain('Completely different');
    expect((await embeddingUsageRows(USER_A)).length).toBe(2); // original + the change
  }, 30000);

  it('treats a case-only content change as a real change, not a duplicate paste', async () => {
    // Regression for reusing intake's dedup hash (which normalises case and
    // whitespace) for staleness detection — a chunk must go stale on any
    // real content change, not only ones that also read as a different
    // posting to the *duplicate-paste* check.
    const cookie = await sessionCookieFor(USER_A);
    const { body: vacancy } = await pasteVacancy(cookie, 'a backend role').expect(201);

    const first = await reindex(cookie).expect(201);
    await waitFor(() => jobCompleted(first.body.jobId));
    const [chunkBefore] = await vacancyChunksFor(USER_A);

    await adminDb
      .update(schema.vacancies)
      .set({ rawText: 'A BACKEND ROLE' })
      .where(eq(schema.vacancies.id, vacancy.id));

    const second = await reindex(cookie).expect(201);
    await waitFor(() => jobCompleted(second.body.jobId));
    const [chunkAfter] = await vacancyChunksFor(USER_A);

    expect(chunkAfter.contentHash).not.toBe(chunkBefore.contentHash);
    expect(chunkAfter.content).toBe('A BACKEND ROLE');
    expect((await embeddingUsageRows(USER_A)).length).toBe(2); // original + the case change
  }, 30000);

  it('cascades chunk deletion when the source vacancy is deleted', async () => {
    const cookie = await sessionCookieFor(USER_A);
    const { body: vacancy } = await pasteVacancy(cookie).expect(201);

    const { body } = await reindex(cookie).expect(201);
    await waitFor(() => jobCompleted(body.jobId));
    expect(await vacancyChunksFor(USER_A)).toHaveLength(1);

    await adminDb.delete(schema.vacancies).where(eq(schema.vacancies.id, vacancy.id));
    expect(await vacancyChunksFor(USER_A)).toHaveLength(0);
  }, 30000);

  it('refuses an unauthenticated reindex', async () => {
    await request(app.getHttpServer()).post('/me/retrieval/reindex').expect(401);
  });
});

describe('search (FR23)', () => {
  it('returns your own chunks, scoped by RLS, never another user\'s', async () => {
    const cookieA = await sessionCookieFor(USER_A);
    const cookieB = await sessionCookieFor(USER_B);
    await seedResumeExtraction(USER_A, { name: 'User A resume' });
    await seedResumeExtraction(USER_B, { name: 'User B resume' });
    await pasteVacancy(cookieA, 'Vacancy for user A.');
    await pasteVacancy(cookieB, 'Vacancy for user B.');

    const jobA = await reindex(cookieA).expect(201);
    const jobB = await reindex(cookieB).expect(201);
    await waitFor(() => jobCompleted(jobA.body.jobId));
    await waitFor(() => jobCompleted(jobB.body.jobId));

    const resA = await search(cookieA, 'anything').expect(200);
    expect(resA.body).toHaveLength(2);
    expect(resA.body.every((hit: { content: string }) => !hit.content.includes('User B'))).toBe(true);

    const resB = await search(cookieB, 'anything').expect(200);
    expect(resB.body).toHaveLength(2);
    expect(resB.body.every((hit: { content: string }) => !hit.content.includes('User A'))).toBe(true);
  }, 30000);

  it('refuses an empty query with 400, spending nothing', async () => {
    const cookie = await sessionCookieFor(USER_A);
    fakeEmbedding.calls = [];
    await search(cookie, '   ').expect(400);
    expect(fakeEmbedding.calls).toHaveLength(0);
  });

  it('refuses an unauthenticated search', async () => {
    await request(app.getHttpServer()).post('/me/retrieval/search').send({ query: 'x' }).expect(401);
  });
});
