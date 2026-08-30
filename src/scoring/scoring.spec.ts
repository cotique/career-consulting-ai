import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../app.module';
import { SESSION_COOKIE, SessionService } from '../auth/session.service';
import { createAdminDb } from '../db/test-db';
import * as schema from '../db/schema';
import { FakeProvider } from '../llm/providers/fake.provider';
import { AnthropicProvider } from '../llm/providers/anthropic.provider';
import type {
  LlmProvider,
  ProviderCompletionParams,
  ProviderCompletionResult,
} from '../llm/providers/provider.interface';
import { vacancyScore } from '../llm/templates/vacancy-score';
import { ThrottlerStorage } from '@nestjs/throttler';
import type { ThrottlerStorageService } from '@nestjs/throttler/dist/throttler.service';

/**
 * T17 end to end: real HTTP through the whole stack, real Postgres. The
 * provider is the only fake — no test calls a paid model.
 *
 * Same caveat as intake.spec.ts: these tests prove the plumbing — that the
 * split between `presentable` and `tradeoff` is stored and returned exactly
 * as the model produced it, that a missing profile/resume never reaches the
 * provider, that a failed attempt still records what it cost. Whether the
 * prompt actually keeps compensation/remote/stack/benefits out of
 * `presentable` on a real vacancy is judged by reading real output — a
 * manual step, deliberately not asserted here.
 */
const { db: adminDb, pool: adminPool } = createAdminDb();

const USER_A = 'c7c7c7c7-0000-4000-8000-00000000c17c';
const USER_B = 'd7d7d7d7-0000-4000-8000-00000000d17d';

let app: INestApplication;
let sessions: SessionService;
let throttlerStorage: ThrottlerStorageService;

let fake = new FakeProvider();
const delegatingProvider: LlmProvider = {
  complete: (params: ProviderCompletionParams): Promise<ProviderCompletionResult> =>
    fake.complete(params),
};

const VACANCY_STRUCTURED = {
  title: 'Backend Engineer',
  companyName: 'Acme sp. z o.o.',
  countryCode: 'PL',
  location: 'Warsaw',
  workMode: 'hybrid',
  employmentType: 'full-time',
  seniority: null,
  requirements: ['Five years of backend experience'],
  responsibilities: ['Own the payments service'],
  languages: [],
  compensation: { min: 20000, max: 26000, currency: 'PLN', period: 'month', raw: '20-26k PLN/mo' },
  intermediary: { isIntermediary: false, evidence: null, endClient: null, endClientEvidence: null },
};

const RESUME_STRUCTURED = {
  contacts: { email: 'candidate@example.com', phone: null, links: [] },
  name: 'Candidate',
  headline: 'Backend Engineer',
  summary: null,
  experience: [{ company: 'Prior Co', title: 'Backend Engineer', start: '2019', end: null, location: null, highlights: [] }],
  education: [],
  skills: ['TypeScript', 'Postgres'],
  languages: [],
};

const DEFAULT_SCORE = {
  score: 0.7,
  presentable: ['Owns a payments service end to end, similar scope to her prior role'],
  tradeoff: { fits: ['Backend-heavy, matches her recent experience'], doesNotFit: [] },
};

function providerResult(body: unknown): ProviderCompletionResult {
  return { text: JSON.stringify(body), inputTokens: 500, outputTokens: 200 };
}

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

/** Seeds a profile, an active resume with an extraction, and a parsed vacancy — everything scoring needs, inserted directly rather than through the HTTP surface each spends its own budget check on. */
async function seedScorableFixtures(userId: string) {
  await adminDb.insert(schema.userProfiles).values({
    userId,
    targetRoles: ['Backend Engineer'],
    locations: ['Warsaw'],
    preferences: { priorities: ['problem space'] },
  });

  const [resume] = await adminDb
    .insert(schema.resumes)
    .values({ userId, blobStoragePath: 'fixtures/resume.pdf', mimeType: 'application/pdf', isActive: true })
    .returning();

  await adminDb.insert(schema.resumeExtractions).values({
    userId,
    resumeId: resume.id,
    structuredJson: RESUME_STRUCTURED,
    modelUsed: 'fixture',
    promptVersion: 'fixture-v1',
  });

  const [vacancy] = await adminDb
    .insert(schema.vacancies)
    .values({
      userId,
      sourceType: 'paste',
      rawText: 'Backend Engineer at Acme',
      rawTextHash: `fixture-${userId}`,
      structuredJson: VACANCY_STRUCTURED,
      parsePromptVersion: 'fixture-v1',
      title: VACANCY_STRUCTURED.title,
      companyName: VACANCY_STRUCTURED.companyName,
      countryCode: VACANCY_STRUCTURED.countryCode,
    })
    .returning();

  return vacancy.id as string;
}

async function scoreRows(userId: string) {
  return adminDb.select().from(schema.vacancyScores).where(eq(schema.vacancyScores.userId, userId));
}

async function usageRows(userId: string) {
  return adminDb.select().from(schema.llmUsageLogs).where(eq(schema.llmUsageLogs.userId, userId));
}

function score(cookie: string, vacancyId: string) {
  return request(app.getHttpServer()).post(`/me/vacancies/${vacancyId}/score`).set('Cookie', cookie);
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(AnthropicProvider)
    .useValue(delegatingProvider)
    .compile();

  app = moduleRef.createNestApplication();
  app.use(cookieParser());
  await app.init();
  sessions = app.get(SessionService);
  throttlerStorage = app.get<ThrottlerStorageService>(ThrottlerStorage);
});

afterAll(async () => {
  for (const userId of [USER_A, USER_B]) {
    await adminDb.delete(schema.users).where(eq(schema.users.id, userId));
  }
  await app?.close();
  await adminPool.end();
});

beforeEach(async () => {
  fake = new FakeProvider(providerResult(DEFAULT_SCORE));
  throttlerStorage.storage.clear();
  for (const userId of [USER_A, USER_B]) {
    await adminDb.delete(schema.users).where(eq(schema.users.id, userId));
  }
  await adminDb.insert(schema.users).values([
    { id: USER_A, name: 'User A' },
    { id: USER_B, name: 'User B' },
  ]);
});

describe('vacancy scoring (FR7)', () => {
  it('writes the score, the split analyses and the prompt version', async () => {
    const cookie = await sessionCookieFor(USER_A);
    const vacancyId = await seedScorableFixtures(USER_A);

    const res = await score(cookie, vacancyId).expect(200);

    expect(res.body).toMatchObject({
      vacancyId,
      score: DEFAULT_SCORE.score,
      promptVersion: vacancyScore.version,
      presentable: DEFAULT_SCORE.presentable,
      tradeoff: DEFAULT_SCORE.tradeoff,
      blockers: [],
    });

    const [row] = await scoreRows(USER_A);
    expect(Number(row.score)).toBeCloseTo(DEFAULT_SCORE.score);
    expect(row.promptVersion).toBe(vacancyScore.version);
    expect(row.breakdown).toMatchObject({ presentable: DEFAULT_SCORE.presentable });

    // Profile, resume and vacancy are all untrusted input: they must arrive
    // as data in the user half of the call, never in the instructions the
    // model is told to follow.
    const [call] = fake.calls;
    expect(call.system).not.toContain('Backend Engineer');
    expect(call.userMessage).toContain('Backend Engineer');
    // Contacts are stripped by the layer before any prompt is built.
    expect(call.userMessage).not.toContain('candidate@example.com');
  });

  it('excludes compensation/remote/stack/benefits from presentable exactly as the model returned it — the leak test', async () => {
    const cookie = await sessionCookieFor(USER_A);
    const vacancyId = await seedScorableFixtures(USER_A);
    // A vacancy whose only genuine attraction is compensation: the fake
    // model (standing in for a prompt that respects the rule) returns an
    // empty presentable list. This proves the plumbing preserves "empty"
    // faithfully — it does not prove a real model would produce it.
    fake = new FakeProvider(
      providerResult({
        score: 0.4,
        presentable: [],
        tradeoff: { fits: [], doesNotFit: ['Pays well above her stated range, nothing else stands out'] },
      }),
    );

    const res = await score(cookie, vacancyId).expect(200);

    expect(res.body.presentable).toEqual([]);
    expect(res.body.tradeoff.doesNotFit).toHaveLength(1);
  });

  it('answers scoring someone else’s vacancy with 404, not 403', async () => {
    const vacancyId = await seedScorableFixtures(USER_A);
    await seedScorableFixtures(USER_B);
    const intruder = await sessionCookieFor(USER_B);

    // Row-level security hides the row, so "not visible" and "does not
    // exist" arrive as the same thing — and must be answered identically.
    await score(intruder, vacancyId).expect(404);
    expect(fake.calls).toHaveLength(0);
  });

  it('refuses to score an unparsed vacancy', async () => {
    const cookie = await sessionCookieFor(USER_A);
    await adminDb.insert(schema.userProfiles).values({ userId: USER_A, targetRoles: ['Anything'] });
    const [unparsed] = await adminDb
      .insert(schema.vacancies)
      .values({ userId: USER_A, sourceType: 'paste', rawText: 'Some posting', rawTextHash: 'unparsed' })
      .returning();

    await score(cookie, unparsed.id).expect(400);
    expect(fake.calls).toHaveLength(0);
  });

  it('refuses with 409 and zero provider calls when there is no profile yet', async () => {
    const cookie = await sessionCookieFor(USER_A);
    // Resume and vacancy exist, but no user_profiles row — onboarding was
    // never finished.
    const [resume] = await adminDb
      .insert(schema.resumes)
      .values({ userId: USER_A, blobStoragePath: 'fixtures/resume.pdf', mimeType: 'application/pdf', isActive: true })
      .returning();
    await adminDb.insert(schema.resumeExtractions).values({
      userId: USER_A,
      resumeId: resume.id,
      structuredJson: RESUME_STRUCTURED,
      modelUsed: 'fixture',
      promptVersion: 'fixture-v1',
    });
    const [vacancy] = await adminDb
      .insert(schema.vacancies)
      .values({
        userId: USER_A,
        sourceType: 'paste',
        rawText: 'Backend Engineer at Acme',
        rawTextHash: 'no-profile',
        structuredJson: VACANCY_STRUCTURED,
      })
      .returning();

    await score(cookie, vacancy.id).expect(409);
    expect(fake.calls).toHaveLength(0);
    expect(await scoreRows(USER_A)).toHaveLength(0);
  });

  it('refuses with 409 and zero provider calls when there is no extracted resume yet', async () => {
    const cookie = await sessionCookieFor(USER_A);
    await adminDb.insert(schema.userProfiles).values({ userId: USER_A, targetRoles: ['Backend Engineer'] });
    const [vacancy] = await adminDb
      .insert(schema.vacancies)
      .values({
        userId: USER_A,
        sourceType: 'paste',
        rawText: 'Backend Engineer at Acme',
        rawTextHash: 'no-resume',
        structuredJson: VACANCY_STRUCTURED,
      })
      .returning();

    await score(cookie, vacancy.id).expect(409);
    expect(fake.calls).toHaveLength(0);
    expect(await scoreRows(USER_A)).toHaveLength(0);
  });

  it('refuses with 409 when a resume exists but has never been extracted', async () => {
    const cookie = await sessionCookieFor(USER_A);
    await adminDb.insert(schema.userProfiles).values({ userId: USER_A, targetRoles: ['Backend Engineer'] });
    // The resume row exists and is active — upload happened — but nothing
    // ever called POST :id/extract, so resume_extractions has no row for it.
    // This exercises the real query branch (`activeResume` truthy, the
    // extraction SELECT itself returns nothing), not just "no resume at all".
    await adminDb
      .insert(schema.resumes)
      .values({ userId: USER_A, blobStoragePath: 'fixtures/resume.pdf', mimeType: 'application/pdf', isActive: true });
    const [vacancy] = await adminDb
      .insert(schema.vacancies)
      .values({
        userId: USER_A,
        sourceType: 'paste',
        rawText: 'Backend Engineer at Acme',
        rawTextHash: 'unextracted-resume',
        structuredJson: VACANCY_STRUCTURED,
      })
      .returning();

    await score(cookie, vacancy.id).expect(409);
    expect(fake.calls).toHaveLength(0);
    expect(await scoreRows(USER_A)).toHaveLength(0);
  });

  it('refuses an unauthenticated score request', async () => {
    const vacancyId = await seedScorableFixtures(USER_A);
    await request(app.getHttpServer()).post(`/me/vacancies/${vacancyId}/score`).expect(401);
    expect(fake.calls).toHaveLength(0);
  });

  it('surfaces the market-scope blocker computed at intake, re-used rather than recomputed', async () => {
    const cookie = await sessionCookieFor(USER_A);
    await adminDb.insert(schema.userProfiles).values({
      userId: USER_A,
      targetRoles: ['Backend Engineer'],
      locations: ['Warsaw'],
      preferences: { priorities: ['problem space'] },
    });
    const [resume] = await adminDb
      .insert(schema.resumes)
      .values({ userId: USER_A, blobStoragePath: 'fixtures/resume.pdf', mimeType: 'application/pdf', isActive: true })
      .returning();
    await adminDb.insert(schema.resumeExtractions).values({
      userId: USER_A,
      resumeId: resume.id,
      structuredJson: RESUME_STRUCTURED,
      modelUsed: 'fixture',
      promptVersion: 'fixture-v1',
    });
    // Same structure as the usual fixture, but outside the supported markets —
    // mirrors intake.spec.ts's own NFR15 test fixture.
    const [vacancy] = await adminDb
      .insert(schema.vacancies)
      .values({
        userId: USER_A,
        sourceType: 'paste',
        rawText: 'Backend Engineer at Acme (Austin)',
        rawTextHash: 'us-vacancy',
        structuredJson: { ...VACANCY_STRUCTURED, countryCode: 'US', location: 'Austin' },
        countryCode: 'US',
      })
      .returning();

    const res = await score(cookie, vacancy.id).expect(200);

    // The blocker in the score response is the same one intake would compute
    // from this vacancy's countryCode — a regression that dropped the
    // `blockersFor` call, or wired it to the wrong field, would still leave
    // `blockers: []` here if nothing asserted this specifically.
    expect(res.body.blockers).toEqual([expect.objectContaining({ kind: 'outside_supported_markets' })]);
    expect(res.body.blockers[0].reason).toContain('US');
  });

  it('answers a malformed response as a client error, and keeps the record of what it cost', async () => {
    const cookie = await sessionCookieFor(USER_A);
    const vacancyId = await seedScorableFixtures(USER_A);
    fake = new FakeProvider({ text: 'not json at all', inputTokens: 500, outputTokens: 10 });

    await score(cookie, vacancyId).expect(400);

    // One bounded retry, then it stops — retrying past that pays twice for
    // the same failure.
    expect(fake.calls).toHaveLength(2);
    // The attempt was paid for whether or not the answer was usable, and the
    // monthly cap is computed from these rows.
    expect(await usageRows(USER_A)).not.toHaveLength(0);
    // No row was written for a score that was never produced.
    expect(await scoreRows(USER_A)).toHaveLength(0);
  });

  it('stores a low score with its readable reason, same as a high one', async () => {
    const cookie = await sessionCookieFor(USER_A);
    const vacancyId = await seedScorableFixtures(USER_A);
    fake = new FakeProvider(
      providerResult({
        score: 0.1,
        presentable: [],
        tradeoff: { fits: [], doesNotFit: ['Role scope is unrelated to anything in her experience'] },
      }),
    );

    const res = await score(cookie, vacancyId).expect(200);

    expect(res.body.score).toBeCloseTo(0.1);
    const [row] = await scoreRows(USER_A);
    expect(row).toBeDefined();
    expect((row.breakdown as { tradeoff: { doesNotFit: string[] } }).tradeoff.doesNotFit[0]).toContain(
      'unrelated',
    );
  });

  it('re-scoring inserts a new snapshot rather than overwriting the last one', async () => {
    const cookie = await sessionCookieFor(USER_A);
    const vacancyId = await seedScorableFixtures(USER_A);
    await score(cookie, vacancyId).expect(200);

    fake = new FakeProvider(providerResult({ ...DEFAULT_SCORE, score: 0.9 }));
    await score(cookie, vacancyId).expect(200);

    const rows = await scoreRows(USER_A);
    expect(rows).toHaveLength(2);
  });
});
