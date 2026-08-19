import { createHash, randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
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
import { resumeExtract } from '../llm/templates/resume-extract';
import { ThrottlerStorage } from '@nestjs/throttler';
import type { ThrottlerStorageService } from '@nestjs/throttler/dist/throttler.service';
import { BlobStorageService } from '../storage/blob-storage.service';

/**
 * T15 end to end: real HTTP through the whole stack (guard, session cookie,
 * per-request RLS connection, multer), real Postgres, real Azurite. The provider
 * is the only fake — no test calls a paid model.
 *
 * Driven over HTTP rather than by calling the service, because routing, the
 * multipart interceptor and the binary response are exactly where an upload
 * endpoint goes wrong, and none of them exist when a handler is called directly.
 */
const { db: adminDb, pool: adminPool } = createAdminDb();

const USER_A = 'a5a5a5a5-0000-4000-8000-00000000a15a';
const USER_B = 'b5b5b5b5-0000-4000-8000-00000000b15b';

let app: INestApplication;
let sessions: SessionService;
let blobs: BlobStorageService;
let throttlerStorage: ThrottlerStorageService;

/**
 * Swappable per test. The Nest container is built once (booting AppModule per
 * test would dominate the runtime), so the provider it holds delegates to
 * whatever `fake` currently points at.
 */
let fake = new FakeProvider();
const delegatingProvider: LlmProvider = {
  complete: (params: ProviderCompletionParams): Promise<ProviderCompletionResult> =>
    fake.complete(params),
};

/** The shape resume_extract promises; `contacts` is the field scrub.ts strips. */
const EXTRACTED = {
  contacts: { email: 'alex@example.com', phone: '+48 123 456 789', links: [] },
  name: 'Alex Nowak',
  headline: 'Product Manager',
  summary: 'Ten years shipping B2B products.',
  experience: [
    {
      company: 'Appspace',
      title: 'Senior PM',
      start: '2021-03',
      end: null,
      location: 'Warsaw',
      highlights: ['Cut onboarding time by half'],
    },
  ],
  education: [],
  skills: ['discovery'],
  languages: [],
};

function extractionResponse(body: unknown = EXTRACTED): ProviderCompletionResult {
  return { text: JSON.stringify(body), inputTokens: 900, outputTokens: 400 };
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

const RESUME_TEXT = [
  'Alex Nowak',
  'alex@example.com | +48 123 456 789',
  '',
  'Senior PM, Appspace, 2021-03 - present, Warsaw',
  '- Cut onboarding time by half',
].join('\n');

/** Returns the supertest Test itself, so callers can chain `.expect(...)`. */
function upload(
  cookie: string,
  content: Buffer = Buffer.from(RESUME_TEXT),
  { filename = 'cv.txt', contentType = 'text/plain' } = {},
) {
  return request(app.getHttpServer())
    .post('/me/resumes')
    .set('Cookie', cookie)
    .attach('file', content, { filename, contentType });
}

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

async function resumeRows(userId: string) {
  return adminDb.select().from(schema.resumes).where(eq(schema.resumes.userId, userId));
}

/**
 * Always scoped by user. The admin connection bypasses RLS, so an unscoped
 * `select()` here would pick up rows other specs left behind and turn a real
 * assertion into a flake that depends on test ordering.
 */
async function extractionRows(userId: string) {
  return adminDb
    .select()
    .from(schema.resumeExtractions)
    .where(eq(schema.resumeExtractions.userId, userId));
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    // The one seam: LlmService takes AnthropicProvider in its constructor, so
    // replacing it here means every LLM call in the app goes to the fake — a
    // test that reached the real API would be slow, non-deterministic and paid.
    .overrideProvider(AnthropicProvider)
    .useValue(delegatingProvider)
    .compile();

  app = moduleRef.createNestApplication();
  app.use(cookieParser());
  await app.init();
  sessions = app.get(SessionService);
  // The app's own storage instance, so assertions look at the same container the
  // handlers wrote to rather than a second client that might differ.
  blobs = app.get(BlobStorageService);
  throttlerStorage = app.get<ThrottlerStorageService>(ThrottlerStorage);
});

afterAll(async () => {
  for (const userId of [USER_A, USER_B]) {
    await blobs?.deleteByPrefix(`${userId}/`);
    await adminDb.delete(schema.users).where(eq(schema.users.id, userId));
  }
  await app?.close();
  await adminPool.end();
});

beforeEach(async () => {
  fake = new FakeProvider(extractionResponse());
  // Extraction is capped at 10/hour because each call is paid. That cap is real
  // and wanted in production, but it counts across the whole suite — so without
  // this, adding an eleventh extraction test makes an unrelated earlier test
  // fail with 429, and the failure points nowhere near the cause.
  throttlerStorage.storage.clear();
  for (const userId of [USER_A, USER_B]) {
    await blobs.deleteByPrefix(`${userId}/`);
    await adminDb.delete(schema.users).where(eq(schema.users.id, userId));
  }
  await adminDb.insert(schema.users).values([
    { id: USER_A, name: 'User A' },
    { id: USER_B, name: 'User B' },
  ]);
});

describe('resume upload (FR4)', () => {
  it('writes both the blob and the row, and never leaves the placeholder path behind', async () => {
    const cookie = await sessionCookieFor(USER_A);
    const content = Buffer.from(RESUME_TEXT);

    const res = await upload(cookie, content).expect(201);
    expect(res.body.id).toBeTruthy();
    expect(res.body.isActive).toBe(true);
    expect(res.body.mimeType).toBe('text/plain');

    const [row] = await resumeRows(USER_A);
    expect(row.id).toBe(res.body.id);
    // The row is inserted with `blob_storage_path: 'pending'` because the key
    // needs the id the database generates. If the follow-up update were ever
    // dropped, every read of this resume would look for a blob named "pending" —
    // so the stored path is asserted, not just the row's existence.
    expect(row.blobStoragePath).toBe(BlobStorageService.keyFor(USER_A, row.id, 'txt'));
    expect(row.blobStoragePath).not.toBe('pending');
    expect(row.isActive).toBe(true);

    expect(await blobs.exists(row.blobStoragePath)).toBe(true);
    expect(sha256(await blobs.download(row.blobStoragePath))).toBe(sha256(content));
  });

  it('lists the resume as uploaded but not yet extracted', async () => {
    const cookie = await sessionCookieFor(USER_A);
    await upload(cookie).expect(201);

    const res = await request(app.getHttpServer())
      .get('/me/resumes')
      .set('Cookie', cookie)
      .expect(200);

    expect(res.body).toHaveLength(1);
    // FR4's second half: a file with no structure yet is an ordinary state and
    // has to be visible. A list that omitted it would present an un-extracted
    // resume as ready to tailor from.
    expect(res.body[0].extraction).toEqual({ state: 'not_extracted' });
    expect(res.body[0].isActive).toBe(true);
  });

  it('rejects an unsupported type over real HTTP without storing anything', async () => {
    const cookie = await sessionCookieFor(USER_A);

    await upload(cookie, randomBytes(64), { filename: 'cv.png', contentType: 'image/png' }).expect(
      400,
    );

    expect(await resumeRows(USER_A)).toHaveLength(0);
    expect(await blobs.deleteByPrefix(`${USER_A}/`)).toBe(0);
  });

  it('refuses a file over the 5 MB cap with a client error, not a server error', async () => {
    const cookie = await sessionCookieFor(USER_A);
    // Over the cap by one byte. Multer's own `limits.fileSize` fires first here,
    // before the service's check ever sees the file — which is the point: the
    // limit exists so an oversized body is refused while it is still being read,
    // not after 5 MB of someone's disk has been buffered.
    const oversized = randomBytes(5 * 1024 * 1024 + 1);

    const res = await upload(cookie, oversized, {
      filename: 'huge.pdf',
      contentType: 'application/pdf',
    });

    // A user uploading too large a CV made a correctable mistake. A 5xx would
    // report it as our failure and tell them nothing they can act on.
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(await resumeRows(USER_A)).toHaveLength(0);
    expect(await blobs.deleteByPrefix(`${USER_A}/`)).toBe(0);
  });

  it('refuses an anonymous upload', async () => {
    await request(app.getHttpServer())
      .post('/me/resumes')
      .attach('file', Buffer.from(RESUME_TEXT), { filename: 'cv.txt', contentType: 'text/plain' })
      .expect(401);
  });
});

describe('GET /me/resumes/:id/content', () => {
  it('returns byte-identical content, including bytes no string round trip survives', async () => {
    const cookie = await sessionCookieFor(USER_A);
    // Random bytes uploaded as a PDF: a real PDF is not valid UTF-8, and any
    // layer that decodes the body to a string on the way out or back in
    // corrupts it while still answering 200. Only the hash notices, which is
    // why the plan asks for a hash rather than a status code.
    const content = randomBytes(128 * 1024);

    const uploaded = await upload(cookie, content, {
      filename: 'cv.pdf',
      contentType: 'application/pdf',
    }).expect(201);

    const res = await request(app.getHttpServer())
      .get(`/me/resumes/${uploaded.body.id}/content`)
      .set('Cookie', cookie)
      // Without this, superagent parses the response by content type and hands
      // back a string — which would make the hash comparison test the parser.
      .responseType('blob')
      .expect(200);

    expect(Buffer.isBuffer(res.body)).toBe(true);
    expect(res.body.length).toBe(content.length);
    expect(sha256(res.body as Buffer)).toBe(sha256(content));
    expect(res.headers['content-type']).toContain('application/pdf');
    // Attachment rather than inline: a PDF we did not author, rendered from our
    // own origin, is a needless script-execution surface.
    expect(res.headers['content-disposition']).toMatch(/^attachment;/);
  });

  it('404s for a resume that does not exist', async () => {
    const cookie = await sessionCookieFor(USER_A);
    await request(app.getHttpServer())
      .get('/me/resumes/ffffffff-0000-4000-8000-0000000000ff/content')
      .set('Cookie', cookie)
      .expect(404);
  });
});

describe('one active resume per user (FR4)', () => {
  it('deactivates the previous resume and leaves exactly one active', async () => {
    const cookie = await sessionCookieFor(USER_A);

    const first = await upload(cookie, Buffer.from('first CV')).expect(201);
    const second = await upload(cookie, Buffer.from('second CV')).expect(201);

    const rows = await resumeRows(USER_A);
    expect(rows).toHaveLength(2);

    const active = rows.filter((r) => r.isActive);
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe(second.body.id);

    // Superseded rows are kept, not deleted: self-audit has to be able to say
    // which version of a CV a tailored document came from.
    const [superseded] = rows.filter((r) => r.id === first.body.id);
    expect(superseded.isActive).toBe(false);
    expect(await blobs.exists(superseded.blobStoragePath)).toBe(true);
  });

  it('keeps a third upload from ever producing two active rows', async () => {
    const cookie = await sessionCookieFor(USER_A);
    await upload(cookie, Buffer.from('v1')).expect(201);
    await upload(cookie, Buffer.from('v2')).expect(201);
    const third = await upload(cookie, Buffer.from('v3')).expect(201);

    const active = (await resumeRows(USER_A)).filter((r) => r.isActive);
    expect(active.map((r) => r.id)).toEqual([third.body.id]);
  });

  it("does not touch another user's active resume", async () => {
    const cookieA = await sessionCookieFor(USER_A);
    const cookieB = await sessionCookieFor(USER_B);

    const b = await upload(cookieB, Buffer.from("B's CV")).expect(201);
    // A's upload deactivates "the user's previous resumes". If that clause ever
    // lost its user_id predicate, this is where it would show.
    await upload(cookieA, Buffer.from("A's CV")).expect(201);

    const [bRow] = await adminDb
      .select()
      .from(schema.resumes)
      .where(and(eq(schema.resumes.userId, USER_B), eq(schema.resumes.id, b.body.id)));
    expect(bRow.isActive).toBe(true);
  });
});

describe('extraction (FR4, NFR11)', () => {
  it('writes a resume_extractions row with prompt_version taken from the registry', async () => {
    const cookie = await sessionCookieFor(USER_A);
    const uploaded = await upload(cookie).expect(201);

    const res = await request(app.getHttpServer())
      .post(`/me/resumes/${uploaded.body.id}/extract`)
      .set('Cookie', cookie)
      .expect(201);

    const [row] = await extractionRows(USER_A);

    expect(row).toBeDefined();
    expect(row.resumeId).toBe(uploaded.body.id);
    // Migration 0012 exists for this column, and the value must come from the
    // registry rather than a literal in the service — otherwise the label and
    // the prompt it names can drift, and self-audit compares outputs from two
    // different prompts under one version.
    expect(row.promptVersion).toBe(resumeExtract.version);
    expect(row.promptVersion).toBe('resume-extract-v1');
    expect(row.modelUsed).toBe('claude-haiku-4-5');
    expect(row.structuredJson).toMatchObject({
      name: 'Alex Nowak',
      skills: ['discovery'],
    });
    expect(res.body.id).toBe(row.id);

    // The extracted structure keeps the user's own contact details — stripping
    // happens on the way *into* a later prompt, not on the way into storage.
    expect((row.structuredJson as typeof EXTRACTED).contacts.email).toBe('alex@example.com');
  });

  it('sends the resume text to the model as delimited untrusted input', async () => {
    const cookie = await sessionCookieFor(USER_A);
    const uploaded = await upload(cookie).expect(201);

    await request(app.getHttpServer())
      .post(`/me/resumes/${uploaded.body.id}/extract`)
      .set('Cookie', cookie)
      .expect(201);

    expect(fake.calls).toHaveLength(1);
    const [call] = fake.calls;
    // A resume is a document from outside the system. It must arrive in the
    // user message inside a labelled data block, never as part of the system
    // instructions, or "ignore your instructions" in a CV becomes an
    // instruction.
    expect(call.userMessage).toContain('Cut onboarding time by half');
    expect(call.system).not.toContain('Cut onboarding time by half');
    expect(call.userMessage).toContain('resume');
  });

  it('surfaces an unusable resume as a 400 rather than an internal error', async () => {
    const cookie = await sessionCookieFor(USER_A);
    const uploaded = await upload(cookie).expect(201);

    // Two attempts of unparseable output is the bounded-retry path giving up.
    // The user's file is at fault (a scan, a mangled layout), so this is a 400
    // with something actionable in it — not a 500 that reads as our bug.
    fake = new FakeProvider(extractionResponse({ experience: 'not an array' }));

    const res = await request(app.getHttpServer())
      .post(`/me/resumes/${uploaded.body.id}/extract`)
      .set('Cookie', cookie)
      .expect(400);

    expect(res.body.message).toMatch(/scan/i);
    expect(fake.calls).toHaveLength(2);
    expect(await extractionRows(USER_A)).toHaveLength(0);
  });

  // Found by code review, not by these tests: the whole extraction used to run
  // inside one transaction, so giving up rolled back the usage rows written by
  // the attempts that had already been paid for. Since the monthly cap (NFR2) is
  // computed from exactly those rows, failing calls cost money and counted for
  // nothing — a spend guard with a hole in the shape of every failure.
  it('still records what a failed extraction cost, because the money was really spent', async () => {
    const cookie = await sessionCookieFor(USER_A);
    const uploaded = await upload(cookie).expect(201);

    fake = new FakeProvider(extractionResponse({ experience: 'not an array' }));

    await request(app.getHttpServer())
      .post(`/me/resumes/${uploaded.body.id}/extract`)
      .set('Cookie', cookie)
      .expect(400);

    expect(fake.calls).toHaveLength(2);
    const logs = await adminDb
      .select()
      .from(schema.llmUsageLogs)
      .where(eq(schema.llmUsageLogs.userId, USER_A));
    expect(logs).toHaveLength(2);
    expect(logs.every((l) => Number(l.costEstimate) > 0)).toBe(true);
  });

  it('reports a truncated answer as a client error, not a 500', async () => {
    const cookie = await sessionCookieFor(USER_A);
    const uploaded = await upload(cookie).expect(201);

    // Cut off mid-object, with the provider's own reason for stopping. The layer
    // identifies this precisely and refuses to pay for a retry — but that
    // diagnosis used to die at the HTTP boundary, where an unmapped LlmError
    // became a bare 500 and told the caller nothing.
    fake = new FakeProvider({
      text: '{"name": "Alex", "experience": [{"company": "Conto',
      inputTokens: 900,
      outputTokens: 4096,
      stopReason: 'max_tokens',
    });

    const res = await request(app.getHttpServer())
      .post(`/me/resumes/${uploaded.body.id}/extract`)
      .set('Cookie', cookie);

    expect(res.status).toBe(400);
    // One attempt, one metered row: truncation is not retried, and the cost of
    // the attempt that did happen survives the failure.
    expect(fake.calls).toHaveLength(1);
    const logs = await adminDb
      .select()
      .from(schema.llmUsageLogs)
      .where(eq(schema.llmUsageLogs.userId, USER_A));
    expect(logs).toHaveLength(1);
    expect(await extractionRows(USER_A)).toHaveLength(0);
  });

  // Every field of ResumeStructureSchema is optional or defaulted, so `{}` is
  // valid — and used to be stored, producing a person with no experience, no
  // education and no skills, which the list endpoint then reported as
  // `extracted`. Absence of an answer must not be recorded as an answer.
  it('refuses to store an empty structure as a successful extraction', async () => {
    const cookie = await sessionCookieFor(USER_A);
    const uploaded = await upload(cookie).expect(201);

    fake = new FakeProvider(extractionResponse({}));

    await request(app.getHttpServer())
      .post(`/me/resumes/${uploaded.body.id}/extract`)
      .set('Cookie', cookie)
      .expect(400);

    expect(await extractionRows(USER_A)).toHaveLength(0);

    const list = await request(app.getHttpServer())
      .get('/me/resumes')
      .set('Cookie', cookie)
      .expect(200);
    expect(list.body[0].extraction.state).toBe('not_extracted');
  });

  it('treats an answer with only contact details as unreadable', async () => {
    const cookie = await sessionCookieFor(USER_A);
    const uploaded = await upload(cookie).expect(201);

    // An email address is not a resume. Counting it as success would file an
    // empty career under a label that claims the file was read.
    fake = new FakeProvider(
      extractionResponse({ contacts: { email: 'alex@example.com', links: [] } }),
    );

    await request(app.getHttpServer())
      .post(`/me/resumes/${uploaded.body.id}/extract`)
      .set('Cookie', cookie)
      .expect(400);

    expect(await extractionRows(USER_A)).toHaveLength(0);
  });

  it('reports the newest extraction when a resume has been extracted twice', async () => {
    const cookie = await sessionCookieFor(USER_A);
    const uploaded = await upload(cookie).expect(201);

    await request(app.getHttpServer())
      .post(`/me/resumes/${uploaded.body.id}/extract`)
      .set('Cookie', cookie)
      .expect(201);

    fake = new FakeProvider(extractionResponse({ ...EXTRACTED, name: 'Alex N.' }));
    const second = await request(app.getHttpServer())
      .post(`/me/resumes/${uploaded.body.id}/extract`)
      .set('Cookie', cookie)
      .expect(201);

    // Two rows exist on purpose — re-extracting after a prompt revision is how
    // self-audit compares versions. Which one the list reports must not depend
    // on the order the planner happened to return them in.
    expect(await extractionRows(USER_A)).toHaveLength(2);

    const list = await request(app.getHttpServer())
      .get('/me/resumes')
      .set('Cookie', cookie)
      .expect(200);
    expect(list.body[0].extraction.at).toBe(second.body.extractedAt);
  });

  it('reports the extraction state in the list once it has run', async () => {
    const cookie = await sessionCookieFor(USER_A);
    const uploaded = await upload(cookie).expect(201);
    await request(app.getHttpServer())
      .post(`/me/resumes/${uploaded.body.id}/extract`)
      .set('Cookie', cookie)
      .expect(201);

    const res = await request(app.getHttpServer())
      .get('/me/resumes')
      .set('Cookie', cookie)
      .expect(200);

    expect(res.body[0].extraction.state).toBe('extracted');
    expect(res.body[0].extraction.promptVersion).toBe(resumeExtract.version);
  });
});

describe('cross-user isolation (NFR4, NFR5)', () => {
  it("another user cannot read my resume through the API", async () => {
    const cookieA = await sessionCookieFor(USER_A);
    const cookieB = await sessionCookieFor(USER_B);
    const mine = await upload(cookieA, Buffer.from('my private CV')).expect(201);

    // B holds a valid session and the exact resume id. The only thing standing
    // between them and the file is the user scoping — which is the property
    // being tested, so the id is handed over rather than guessed.
    const res = await request(app.getHttpServer())
      .get(`/me/resumes/${mine.body.id}/content`)
      .set('Cookie', cookieB)
      .expect(404);

    // 404, not 403: a distinct "forbidden" would confirm that this resume id
    // exists, which is itself a leak.
    expect(JSON.stringify(res.body)).not.toContain('my private CV');

    const list = await request(app.getHttpServer())
      .get('/me/resumes')
      .set('Cookie', cookieB)
      .expect(200);
    expect(list.body).toHaveLength(0);
  });

  it("another user cannot trigger extraction of my resume", async () => {
    const cookieA = await sessionCookieFor(USER_A);
    const cookieB = await sessionCookieFor(USER_B);
    const mine = await upload(cookieA).expect(201);

    await request(app.getHttpServer())
      .post(`/me/resumes/${mine.body.id}/extract`)
      .set('Cookie', cookieB)
      .expect(404);

    // Refused before any spend, and with no row attributed to either user.
    expect(fake.calls).toHaveLength(0);
    expect(await extractionRows(USER_A)).toHaveLength(0);
    expect(await extractionRows(USER_B)).toHaveLength(0);
  });
});

/**
 * T7's deferred half, finally executable.
 *
 * `deleteUserData` is deliberately database-only and relies on ON DELETE
 * CASCADE. Blobs are not in the database, so nothing about the cascade reaches
 * them: without an explicit prefix delete, a resume would keep existing in
 * storage after the account that owned it was erased — personal data outliving
 * an erasure request (FR5, NFR6, NFR16). At T7 there were no blobs to test
 * against. There are now.
 */
describe("account deletion removes the blobs too (T7's debt, FR5/NFR6)", () => {
  it('leaves nothing in storage after DELETE /me', async () => {
    const cookie = await sessionCookieFor(USER_A);
    const uploaded = await upload(cookie, Buffer.from('a real CV')).expect(201);
    const [row] = await resumeRows(USER_A);
    const key = row.blobStoragePath;

    // Established first, so a passing test cannot be a file that was never
    // stored in the first place.
    expect(await blobs.exists(key)).toBe(true);

    const res = await request(app.getHttpServer())
      .delete('/me?confirm=DELETE')
      .set('Cookie', cookie)
      .expect(200);

    expect(await blobs.exists(key)).toBe(false);
    // The count matters: "deleted 0 blobs" and "there was nothing to delete"
    // are the same HTTP response, and only one of them means erasure worked.
    expect(res.body.blobsDeleted).toBe(1);
    expect(await resumeRows(USER_A)).toHaveLength(0);
    expect(uploaded.body.id).toBeTruthy();
  });

  it('removes every resume, superseded ones included', async () => {
    const cookie = await sessionCookieFor(USER_A);
    await upload(cookie, Buffer.from('v1')).expect(201);
    await upload(cookie, Buffer.from('v2')).expect(201);
    const keys = (await resumeRows(USER_A)).map((r) => r.blobStoragePath);
    expect(keys).toHaveLength(2);

    const res = await request(app.getHttpServer())
      .delete('/me?confirm=DELETE')
      .set('Cookie', cookie)
      .expect(200);

    // Deletion is by user prefix rather than by row, which is what makes this
    // hold for a deactivated resume, and for an orphaned blob whose row never
    // got written.
    expect(res.body.blobsDeleted).toBe(2);
    for (const key of keys) {
      expect(await blobs.exists(key)).toBe(false);
    }
  });

  it("does not touch another user's files", async () => {
    const cookieA = await sessionCookieFor(USER_A);
    const cookieB = await sessionCookieFor(USER_B);
    await upload(cookieA, Buffer.from("A's CV")).expect(201);
    await upload(cookieB, Buffer.from("B's CV")).expect(201);
    const [bRow] = await resumeRows(USER_B);

    await request(app.getHttpServer())
      .delete('/me?confirm=DELETE')
      .set('Cookie', cookieA)
      .expect(200);

    expect(await blobs.exists(bRow.blobStoragePath)).toBe(true);
  });

  it('does not delete blobs when the confirmation token is missing', async () => {
    const cookie = await sessionCookieFor(USER_A);
    await upload(cookie).expect(201);
    const [row] = await resumeRows(USER_A);

    await request(app.getHttpServer()).delete('/me').set('Cookie', cookie).expect(400);

    // The guard has to run before the irreversible half. An unconfirmed request
    // that still wiped storage would be the worst of both outcomes: the account
    // survives and its files do not.
    expect(await blobs.exists(row.blobStoragePath)).toBe(true);
    expect(await resumeRows(USER_A)).toHaveLength(1);
  });
});
