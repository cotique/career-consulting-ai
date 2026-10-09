import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { ThrottlerStorage } from '@nestjs/throttler';
import type { ThrottlerStorageService } from '@nestjs/throttler/dist/throttler.service';
import { AppModule } from '../app.module';
import { SESSION_COOKIE, SessionService } from '../auth/session.service';
import { createAdminDb } from '../db/test-db';
import * as schema from '../db/schema';
import { AnthropicProvider } from '../llm/providers/anthropic.provider';
import { FakeProvider } from '../llm/providers/fake.provider';
import type {
  LlmProvider,
  ProviderCompletionParams,
  ProviderCompletionResult,
} from '../llm/providers/provider.interface';
import { TASK_MODELS } from '../llm/task-config';
import { resumeTailor } from '../llm/templates/resume-tailor';

/**
 * Resume tailoring end to end (FR25): real HTTP through the whole stack, real
 * Postgres, a fake provider. These tests prove the plumbing and the limits the
 * code puts around the model — a plan is applied to the original resume, a bad
 * one is refused, the person's contact details never reach the prompt, and
 * another user's rows are unreachable. Whether the prompt produces *good*
 * tailoring is judged by reading real output, deliberately not asserted here.
 */
const { db: adminDb, pool: adminPool } = createAdminDb();

const USER_A = 'e7e7e7e7-0000-4000-8000-00000000a25a';
const USER_B = 'f7f7f7f7-0000-4000-8000-00000000b25b';

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
  requirements: ['CI/CD pipeline experience', 'Mentoring engineers'],
  responsibilities: ['Own the payments service'],
  languages: [],
  compensation: null,
  intermediary: { isIntermediary: false, evidence: null, endClient: null, endClientEvidence: null },
};

const RESUME_STRUCTURED = {
  contacts: { email: 'candidate@example.com', phone: '+48 600 100 200', links: [] },
  name: 'Candidate',
  headline: 'Backend Engineer',
  summary: null,
  experience: [
    {
      company: 'Prior Co',
      title: 'Senior Engineer',
      start: '2019-03',
      end: null,
      location: null,
      highlights: ['Ran the deploy pipeline for 12 services', 'Mentored 3 engineers', 'Cut cloud spend by 30%'],
    },
  ],
  education: [],
  skills: ['TypeScript', 'Postgres', 'Docker'],
  languages: [],
};

const REORDER_PLAN = {
  highlightOrder: [{ experienceIndex: 0, order: [1, 0, 2] }],
  skillsOrder: [1, 0, 2],
  keywordEdits: [],
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

/** Seeds an active resume with an extraction and a parsed vacancy, directly rather than through the paid HTTP surface. */
async function seedTailorableFixtures(userId: string) {
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

  return { vacancyId: vacancy.id as string, resumeId: resume.id as string };
}

async function documentRows(userId: string) {
  return adminDb.select().from(schema.tailoredDocuments).where(eq(schema.tailoredDocuments.userId, userId));
}

async function usageRows(userId: string) {
  return adminDb.select().from(schema.llmUsageLogs).where(eq(schema.llmUsageLogs.userId, userId));
}

function tailor(cookie: string, vacancyId: string) {
  return request(app.getHttpServer()).post(`/me/vacancies/${vacancyId}/tailor`).set('Cookie', cookie);
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
  fake = new FakeProvider(providerResult(REORDER_PLAN));
  throttlerStorage.storage.clear();
  for (const userId of [USER_A, USER_B]) {
    await adminDb.delete(schema.users).where(eq(schema.users.id, userId));
  }
  await adminDb.insert(schema.users).values([
    { id: USER_A, name: 'User A' },
    { id: USER_B, name: 'User B' },
  ]);
});

describe('tailoring a resume (FR25)', () => {
  it('stores a draft built from the original resume, with the plan applied', async () => {
    const cookie = await sessionCookieFor(USER_A);
    const { vacancyId, resumeId } = await seedTailorableFixtures(USER_A);

    const res = await tailor(cookie, vacancyId).expect(201);

    expect(res.body).toMatchObject({
      vacancyId,
      resumeId,
      docType: 'resume',
      version: 1,
      state: 'draft',
      createdBy: 'agent',
      promptVersion: resumeTailor.version,
      modelUsed: TASK_MODELS.tailoring.model,
    });
    expect(res.body.structure.experience[0].highlights).toEqual([
      'Mentored 3 engineers',
      'Ran the deploy pipeline for 12 services',
      'Cut cloud spend by 30%',
    ]);
    expect(res.body.structure.skills).toEqual(['Postgres', 'TypeScript', 'Docker']);
    expect(res.body.changes.highlightsReordered).toEqual([{ experienceIndex: 0, order: [1, 0, 2] }]);

    // Contact details are put back by code for the rendered document.
    expect(res.body.content).toContain('candidate@example.com');
    expect(res.body.content).toContain('Prior Co');

    const [row] = await documentRows(USER_A);
    expect(row.state).toBe('draft');
    expect(row.promptVersion).toBe(resumeTailor.version);
  });

  it('shows the model numbered bullets as data and never the contact details', async () => {
    const cookie = await sessionCookieFor(USER_A);
    const { vacancyId } = await seedTailorableFixtures(USER_A);

    await tailor(cookie, vacancyId).expect(201);

    const [call] = fake.calls;
    expect(call.userMessage).toContain('Mentored 3 engineers');
    expect(call.userMessage).toContain('"index"');
    expect(call.system).not.toContain('Mentored 3 engineers');
    expect(call.userMessage).not.toContain('candidate@example.com');
    expect(call.userMessage).not.toContain('600 100 200');
  });

  it('inserts a new version on a second run rather than overwriting the first', async () => {
    const cookie = await sessionCookieFor(USER_A);
    const { vacancyId } = await seedTailorableFixtures(USER_A);

    await tailor(cookie, vacancyId).expect(201);
    const second = await tailor(cookie, vacancyId).expect(201);

    expect(second.body.version).toBe(2);
    const rows = await documentRows(USER_A);
    expect(rows.map((r) => r.version).sort()).toEqual([1, 2]);
  });

  it('cannot be made to change a company, a date, a title or a skill — the leak test', async () => {
    const cookie = await sessionCookieFor(USER_A);
    const { vacancyId } = await seedTailorableFixtures(USER_A);
    // A hostile or confused model volunteering fields the plan has no place for.
    fake = new FakeProvider(
      providerResult({
        ...REORDER_PLAN,
        experience: [{ company: 'Google', title: 'CTO', start: '2001', end: '2024' }],
        skills: ['Rust', 'Kubernetes'],
        name: 'Someone Else',
      }),
    );

    const res = await tailor(cookie, vacancyId).expect(201);

    const { experience, skills, name } = res.body.structure;
    expect(experience).toHaveLength(1);
    expect(experience[0]).toMatchObject({ company: 'Prior Co', title: 'Senior Engineer', start: '2019-03', end: null });
    expect([...skills].sort()).toEqual(['Docker', 'Postgres', 'TypeScript']);
    expect(name).toBe('Candidate');
  });

  it('applies a supported keyword edit and records the refusal of an unsupported one', async () => {
    const cookie = await sessionCookieFor(USER_A);
    const { vacancyId } = await seedTailorableFixtures(USER_A);
    fake = new FakeProvider(
      providerResult({
        highlightOrder: [],
        skillsOrder: [],
        keywordEdits: [
          { experienceIndex: 0, highlightIndex: 0, text: 'Ran the CI/CD pipeline for 12 services', keywords: ['CI/CD'] },
          { experienceIndex: 0, highlightIndex: 2, text: 'Cut cloud spend by 30% with Kubernetes', keywords: ['Kubernetes'] },
        ],
      }),
    );

    const res = await tailor(cookie, vacancyId).expect(201);

    expect(res.body.structure.experience[0].highlights).toEqual([
      'Ran the CI/CD pipeline for 12 services',
      'Mentored 3 engineers',
      'Cut cloud spend by 30%',
    ]);
    expect(res.body.changes.edits).toHaveLength(1);
    expect(res.body.changes.edits[0]).toMatchObject({
      before: 'Ran the deploy pipeline for 12 services',
      after: 'Ran the CI/CD pipeline for 12 services',
    });
    expect(res.body.changes.rejectedEdits).toHaveLength(1);
    expect(res.body.content).not.toContain('Kubernetes');
  });

  it('answers a plan that misreads the resume with a client error, stores nothing, and keeps the cost', async () => {
    const cookie = await sessionCookieFor(USER_A);
    const { vacancyId } = await seedTailorableFixtures(USER_A);
    fake = new FakeProvider(
      providerResult({ highlightOrder: [{ experienceIndex: 0, order: [0, 0, 1] }], skillsOrder: [], keywordEdits: [] }),
    );

    await tailor(cookie, vacancyId).expect(400);

    expect(await documentRows(USER_A)).toHaveLength(0);
    // The call was real money even though its answer was unusable.
    expect((await usageRows(USER_A)).length).toBeGreaterThan(0);
    // A plan that cannot be applied is not retried: same input, same misreading.
    expect(fake.calls).toHaveLength(1);
  });

  it('answers a malformed response as a client error and keeps the record of what it cost', async () => {
    const cookie = await sessionCookieFor(USER_A);
    const { vacancyId } = await seedTailorableFixtures(USER_A);
    fake = new FakeProvider({ text: 'not json at all', inputTokens: 300, outputTokens: 50 });

    await tailor(cookie, vacancyId).expect(400);

    expect(await documentRows(USER_A)).toHaveLength(0);
    expect((await usageRows(USER_A)).length).toBeGreaterThan(0);
  });

  it('answers tailoring someone else’s vacancy with 404, not 403, and makes no model call', async () => {
    const { vacancyId } = await seedTailorableFixtures(USER_A);
    await seedTailorableFixtures(USER_B);
    const intruder = await sessionCookieFor(USER_B);

    await tailor(intruder, vacancyId).expect(404);
    expect(fake.calls).toHaveLength(0);
  });

  it('refuses an unparsed vacancy with 400 and no model call', async () => {
    const cookie = await sessionCookieFor(USER_A);
    const [unparsed] = await adminDb
      .insert(schema.vacancies)
      .values({ userId: USER_A, sourceType: 'paste', rawText: 'Some posting', rawTextHash: 'unparsed' })
      .returning();

    await tailor(cookie, unparsed.id).expect(400);
    expect(fake.calls).toHaveLength(0);
  });

  it('refuses with 409 and no model call when no resume has been extracted', async () => {
    const cookie = await sessionCookieFor(USER_A);
    const [vacancy] = await adminDb
      .insert(schema.vacancies)
      .values({
        userId: USER_A,
        sourceType: 'paste',
        rawText: 'Backend Engineer at Acme',
        rawTextHash: 'no-resume',
        structuredJson: VACANCY_STRUCTURED,
        parsePromptVersion: 'fixture-v1',
      })
      .returning();

    await tailor(cookie, vacancy.id).expect(409);
    expect(fake.calls).toHaveLength(0);
  });

  it('requires a session', async () => {
    const { vacancyId } = await seedTailorableFixtures(USER_A);
    await request(app.getHttpServer()).post(`/me/vacancies/${vacancyId}/tailor`).expect(401);
  });
});

describe('reading and approving a tailored document', () => {
  async function tailoredFor(userId: string) {
    const cookie = await sessionCookieFor(userId);
    const { vacancyId } = await seedTailorableFixtures(userId);
    const res = await tailor(cookie, vacancyId).expect(201);
    return { cookie, vacancyId, id: res.body.id as string };
  }

  it('lets the owner read it and refuses anyone else with 404', async () => {
    const { cookie, id } = await tailoredFor(USER_A);
    const intruder = await sessionCookieFor(USER_B);

    const own = await request(app.getHttpServer()).get(`/me/tailored-documents/${id}`).set('Cookie', cookie).expect(200);
    expect(own.body.id).toBe(id);
    await request(app.getHttpServer()).get(`/me/tailored-documents/${id}`).set('Cookie', intruder).expect(404);
  });

  it('approves for the owner, and idempotently', async () => {
    const { cookie, id } = await tailoredFor(USER_A);
    const approve = () =>
      request(app.getHttpServer()).patch(`/me/tailored-documents/${id}/approve`).set('Cookie', cookie);

    expect((await approve().expect(200)).body.state).toBe('approved');
    expect((await approve().expect(200)).body.state).toBe('approved');
    expect((await documentRows(USER_A))[0].state).toBe('approved');
  });

  it('does not let another user approve it', async () => {
    const { id } = await tailoredFor(USER_A);
    const intruder = await sessionCookieFor(USER_B);

    await request(app.getHttpServer()).patch(`/me/tailored-documents/${id}/approve`).set('Cookie', intruder).expect(404);
    expect((await documentRows(USER_A))[0].state).toBe('draft');
  });

  it('appears in the account export, and goes when its vacancy goes', async () => {
    const { cookie, vacancyId, id } = await tailoredFor(USER_A);

    const exported = await request(app.getHttpServer()).get('/me/export').set('Cookie', cookie).expect(200);
    const exportedDoc = exported.body.tailoredDocuments.find((d: { id: string }) => d.id === id);
    expect(exportedDoc.structure.name).toBe('Candidate');
    expect(exportedDoc.changes).toBeDefined();

    await adminDb.delete(schema.vacancies).where(eq(schema.vacancies.id, vacancyId));
    expect(await documentRows(USER_A)).toHaveLength(0);
  });
});
