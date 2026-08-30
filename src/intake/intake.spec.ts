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
import { vacancyParse } from '../llm/templates/vacancy-parse';
import { ThrottlerStorage } from '@nestjs/throttler';
import type { ThrottlerStorageService } from '@nestjs/throttler/dist/throttler.service';
import { MAX_PASTE_CHARS } from './paste';

/**
 * T16 end to end: real HTTP through the whole stack (guard, session cookie,
 * per-request RLS connection), real Postgres. The provider is the only fake —
 * no test calls a paid model.
 *
 * What a fake provider can and cannot prove is worth stating, because the
 * intermediary field invites the confusion: these tests prove the *plumbing* —
 * that whatever the model returned is stored faithfully, that a null verdict
 * stays null, that failures land as the right status. Whether the prompt
 * actually recognises an agency posting is judged by reading real output, which
 * is a manual step and deliberately not asserted here.
 */
const { db: adminDb, pool: adminPool } = createAdminDb();

const USER_A = 'a6a6a6a6-0000-4000-8000-00000000a16a';
const USER_B = 'b6b6b6b6-0000-4000-8000-00000000b16b';

let app: INestApplication;
let sessions: SessionService;
let throttlerStorage: ThrottlerStorageService;

let fake = new FakeProvider();
const delegatingProvider: LlmProvider = {
  complete: (params: ProviderCompletionParams): Promise<ProviderCompletionResult> =>
    fake.complete(params),
};

const VACANCY_TEXT = [
  'Senior Product Manager',
  'Acme sp. z o.o. — Warsaw, hybrid',
  '',
  'What you will do: own the discovery process end to end.',
  'What we ask for: five years in B2B product.',
].join('\n');

/** The shape `vacancy_parse` promises, for a straightforward direct posting. */
const PARSED = {
  title: 'Senior Product Manager',
  companyName: 'Acme sp. z o.o.',
  countryCode: 'PL',
  location: 'Warsaw',
  workMode: 'hybrid',
  employmentType: 'full-time',
  seniority: 'senior',
  requirements: ['Five years in B2B product'],
  responsibilities: ['Own the discovery process end to end'],
  languages: [{ language: 'English', level: 'fluent' }],
  compensation: { min: 20000, max: 26000, currency: 'PLN', period: 'month', raw: '20-26k PLN/mo' },
  intermediary: {
    isIntermediary: null,
    evidence: null,
    endClient: null,
    endClientEvidence: null,
  },
};

function parseResponse(body: unknown = PARSED): ProviderCompletionResult {
  return { text: JSON.stringify(body), inputTokens: 700, outputTokens: 300 };
}

/** Mints a session cookie directly — the Google round trip can't run in a test. */
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

function paste(cookie: string, rawText: string = VACANCY_TEXT, sourceUrl?: string) {
  return request(app.getHttpServer())
    .post('/me/vacancies')
    .set('Cookie', cookie)
    .send({ rawText, ...(sourceUrl ? { sourceUrl } : {}) });
}

/**
 * Always scoped by user. The admin connection bypasses RLS, so an unscoped
 * select here would pick up rows other specs left behind and turn a real
 * assertion into a flake that depends on test ordering.
 */
async function vacancyRows(userId: string) {
  return adminDb.select().from(schema.vacancies).where(eq(schema.vacancies.userId, userId));
}

async function usageRows(userId: string) {
  return adminDb.select().from(schema.llmUsageLogs).where(eq(schema.llmUsageLogs.userId, userId));
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
  fake = new FakeProvider(parseResponse());
  // Parsing is capped per hour because each call is paid. The cap is real and
  // wanted in production, but it counts across the whole suite — without this,
  // adding one more parse test makes an unrelated earlier one fail with 429,
  // and the failure points nowhere near the cause.
  throttlerStorage.storage.clear();
  for (const userId of [USER_A, USER_B]) {
    await adminDb.delete(schema.users).where(eq(schema.users.id, userId));
  }
  await adminDb.insert(schema.users).values([
    { id: USER_A, name: 'User A' },
    { id: USER_B, name: 'User B' },
  ]);
});

describe('vacancy paste (FR6)', () => {
  it('stores the posting verbatim and answers 201, without spending anything', async () => {
    const cookie = await sessionCookieFor(USER_A);

    const res = await paste(cookie, VACANCY_TEXT, 'https://example.com/jobs/1').expect(201);

    expect(res.body).toMatchObject({
      duplicate: false,
      sourceType: 'paste',
      sourceUrl: 'https://example.com/jobs/1',
      parse: { state: 'not_parsed' },
      blockers: [],
    });

    const [row] = await vacancyRows(USER_A);
    expect(row.rawText).toBe(VACANCY_TEXT);
    expect(row.rawTextHash).toMatch(/^[0-9a-f]{64}$/);
    // Pasting is free. If this ever fails, a parse has been wired into the
    // paste path and every pasted posting now costs money.
    expect(fake.calls).toHaveLength(0);
  });

  it('routes an exact repeat to the row that already holds it, and loses nothing', async () => {
    const cookie = await sessionCookieFor(USER_A);
    const first = await paste(cookie).expect(201);

    // Same posting, selected slightly differently: leading blank line, tabs for
    // spaces, a stray trailing newline. This is what pasting twice looks like.
    const repeat = `\n${VACANCY_TEXT.replace(/ /g, '\t')}\n`;
    const second = await paste(cookie, repeat).expect(200);

    expect(second.body).toMatchObject({ id: first.body.id, duplicate: true });
    // 200 rather than 201 is the whole point: nothing was created, and a client
    // that acts on the status is told so.
    expect(await vacancyRows(USER_A)).toHaveLength(1);
  });

  it('keeps the same text under two different users apart', async () => {
    const a = await paste(await sessionCookieFor(USER_A)).expect(201);
    const b = await paste(await sessionCookieFor(USER_B)).expect(201);

    // The hash is identical; the dedup lookup is scoped by owner, so B's paste
    // must not be routed into A's row.
    expect(b.body.id).not.toBe(a.body.id);
    expect(await vacancyRows(USER_B)).toHaveLength(1);
  });

  it('refuses an empty paste and an oversized one', async () => {
    const cookie = await sessionCookieFor(USER_A);
    await paste(cookie, '   ').expect(400);
    await paste(cookie, 'x'.repeat(MAX_PASTE_CHARS + 1)).expect(400);
    await paste(cookie, VACANCY_TEXT, 'javascript:alert(1)').expect(400);
    expect(await vacancyRows(USER_A)).toHaveLength(0);
  });

  it('refuses an unauthenticated paste', async () => {
    await request(app.getHttpServer()).post('/me/vacancies').send({ rawText: VACANCY_TEXT }).expect(401);
  });
});

describe('vacancy parsing (FR6)', () => {
  it('writes the structure, the columns a list reads, and the prompt version', async () => {
    const cookie = await sessionCookieFor(USER_A);
    const { body: pasted } = await paste(cookie).expect(201);

    const res = await request(app.getHttpServer())
      .post(`/me/vacancies/${pasted.id}/parse`)
      .set('Cookie', cookie)
      .expect(200);

    expect(res.body).toMatchObject({
      parse: { state: 'parsed', promptVersion: vacancyParse.version },
      title: 'Senior Product Manager',
      companyName: 'Acme sp. z o.o.',
      countryCode: 'PL',
      blockers: [],
    });

    const [row] = await vacancyRows(USER_A);
    expect(row.structuredJson).toMatchObject({ requirements: ['Five years in B2B product'] });
    expect(row.parsePromptVersion).toBe(vacancyParse.version);

    // The posting is untrusted text: it must arrive as data in the user half of
    // the call, never in the instructions the model is told to follow.
    const [call] = fake.calls;
    expect(call.system).not.toContain('Senior Product Manager');
    expect(call.userMessage).toContain('Senior Product Manager');
  });

  it('keeps an undecided intermediary verdict undecided', async () => {
    const cookie = await sessionCookieFor(USER_A);
    const { body: pasted } = await paste(cookie).expect(201);

    const res = await request(app.getHttpServer())
      .post(`/me/vacancies/${pasted.id}/parse`)
      .set('Cookie', cookie)
      .expect(200);

    // Null must survive as null. Defaulting it to false anywhere on the way
    // through would turn "the posting does not say" into "this is the employer
    // hiring directly" — the one wrong answer here that costs an application.
    expect(res.body.structured.intermediary.isIntermediary).toBeNull();
  });

  it('stores an intermediary verdict together with the words it rests on', async () => {
    const cookie = await sessionCookieFor(USER_A);
    const { body: pasted } = await paste(cookie).expect(201);
    fake = new FakeProvider(
      parseResponse({
        ...PARSED,
        companyName: 'TalentBridge Recruitment',
        intermediary: {
          isIntermediary: true,
          evidence: 'Our client, a leading fintech, is looking for',
          endClient: 'Fintechy S.A.',
          endClientEvidence: 'You will join Fintechy S.A. as their first PM',
        },
      }),
    );

    const res = await request(app.getHttpServer())
      .post(`/me/vacancies/${pasted.id}/parse`)
      .set('Cookie', cookie)
      .expect(200);

    // The evidence is the point. A boolean on its own is an opinion with a
    // verdict's authority; quoted words are checkable in a second.
    expect(res.body.structured.intermediary).toMatchObject({
      isIntermediary: true,
      evidence: 'Our client, a leading fintech, is looking for',
      endClient: 'Fintechy S.A.',
    });
  });

  it('refuses a parse that said nothing, and keeps the record of what it cost', async () => {
    const cookie = await sessionCookieFor(USER_A);
    const { body: pasted } = await paste(cookie).expect(201);
    // `{}` satisfies the schema — every field is optional — and would arrive as
    // a job with no title at no company.
    fake = new FakeProvider(parseResponse({}));

    await request(app.getHttpServer())
      .post(`/me/vacancies/${pasted.id}/parse`)
      .set('Cookie', cookie)
      .expect(400);

    const [row] = await vacancyRows(USER_A);
    expect(row.structuredJson).toBeNull();
    expect(row.parsePromptVersion).toBeNull();
    // The call was paid for whether or not we could use the answer, and the
    // monthly cap is computed from these rows.
    expect(await usageRows(USER_A)).not.toHaveLength(0);
  });

  it('answers a malformed response as a client error rather than a 500', async () => {
    const cookie = await sessionCookieFor(USER_A);
    const { body: pasted } = await paste(cookie).expect(201);
    fake = new FakeProvider({ text: 'not json at all', inputTokens: 700, outputTokens: 10 });

    await request(app.getHttpServer())
      .post(`/me/vacancies/${pasted.id}/parse`)
      .set('Cookie', cookie)
      .expect(400);

    // One bounded retry, then it stops. Retrying past that pays repeatedly for
    // the same failure.
    expect(fake.calls).toHaveLength(2);
  });

  it('re-parsing overwrites, so a prompt revision can be applied to what is stored', async () => {
    const cookie = await sessionCookieFor(USER_A);
    const { body: pasted } = await paste(cookie).expect(201);
    await request(app.getHttpServer())
      .post(`/me/vacancies/${pasted.id}/parse`)
      .set('Cookie', cookie)
      .expect(200);

    fake = new FakeProvider(parseResponse({ ...PARSED, title: 'Lead Product Manager' }));
    const res = await request(app.getHttpServer())
      .post(`/me/vacancies/${pasted.id}/parse`)
      .set('Cookie', cookie)
      .expect(200);

    expect(res.body.title).toBe('Lead Product Manager');
    expect(await vacancyRows(USER_A)).toHaveLength(1);
  });

  it('answers someone else’s vacancy with 404, not 403', async () => {
    const { body: theirs } = await paste(await sessionCookieFor(USER_A)).expect(201);
    const intruder = await sessionCookieFor(USER_B);

    // Row-level security hides the row, so "not visible" and "does not exist"
    // arrive as the same thing — and must be answered identically, or the
    // endpoint confirms that someone else's id exists.
    await request(app.getHttpServer()).get(`/me/vacancies/${theirs.id}`).set('Cookie', intruder).expect(404);
    await request(app.getHttpServer())
      .post(`/me/vacancies/${theirs.id}/parse`)
      .set('Cookie', intruder)
      .expect(404);
    expect(fake.calls).toHaveLength(0);
  });
});

describe('vacancies outside the supported markets (NFR15)', () => {
  it('stores one, marks it, and keeps it out of the default list without deleting it', async () => {
    const cookie = await sessionCookieFor(USER_A);
    const { body: pasted } = await paste(cookie).expect(201);
    fake = new FakeProvider(parseResponse({ ...PARSED, countryCode: 'US', location: 'Austin' }));

    // Parsed, stored, and answered normally — the market is a fact about the
    // vacancy, not a reason to refuse the paste.
    const parsed = await request(app.getHttpServer())
      .post(`/me/vacancies/${pasted.id}/parse`)
      .set('Cookie', cookie)
      .expect(200);
    expect(parsed.body.blockers).toEqual([
      expect.objectContaining({ kind: 'outside_supported_markets' }),
    ]);

    const byDefault = await request(app.getHttpServer())
      .get('/me/vacancies')
      .set('Cookie', cookie)
      .expect(200);
    expect(byDefault.body).toHaveLength(0);

    const all = await request(app.getHttpServer())
      .get('/me/vacancies?all=true')
      .set('Cookie', cookie)
      .expect(200);
    expect(all.body).toHaveLength(1);
    // Hidden from a list, never hidden from the person: the reason is readable.
    expect(all.body[0].blockers[0].reason).toContain('US');
  });

  it('does not treat a posting that never said where the work is as blocked', async () => {
    const cookie = await sessionCookieFor(USER_A);
    const { body: pasted } = await paste(cookie).expect(201);
    fake = new FakeProvider(parseResponse({ ...PARSED, countryCode: null, location: null }));

    await request(app.getHttpServer())
      .post(`/me/vacancies/${pasted.id}/parse`)
      .set('Cookie', cookie)
      .expect(200);

    // "Does not say" and "says somewhere unsupported" are different facts.
    // Collapsing them hides vacancies for being vague.
    const list = await request(app.getHttpServer()).get('/me/vacancies').set('Cookie', cookie).expect(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].blockers).toEqual([]);
  });

  it('drops a country the model wrote out in full rather than storing it', async () => {
    const cookie = await sessionCookieFor(USER_A);
    const { body: pasted } = await paste(cookie).expect(201);
    fake = new FakeProvider(parseResponse({ ...PARSED, countryCode: 'Poland' }));

    const res = await request(app.getHttpServer())
      .post(`/me/vacancies/${pasted.id}/parse`)
      .set('Cookie', cookie)
      .expect(200);

    // Market behaviour keys off this column. "Poland" sitting where "PL" is
    // expected breaks no constraint and matches no list — it would just quietly
    // stop being European.
    expect(res.body.countryCode).toBeNull();
  });
});
