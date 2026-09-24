import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../app.module';
import { SESSION_COOKIE, SessionService } from '../auth/session.service';
import { createAdminDb, createTestDb } from '../db/test-db';
import * as schema from '../db/schema';
import { JOB_NAMES } from '../jobs/job-name';
import { JobQueueService } from '../jobs/job-queue.service';
import { FakeProvider } from '../llm/providers/fake.provider';
import { AnthropicProvider } from '../llm/providers/anthropic.provider';
import type {
  LlmProvider,
  ProviderCompletionParams,
  ProviderCompletionResult,
} from '../llm/providers/provider.interface';

/**
 * T21 end to end: real HTTP through the whole stack, real Postgres, and the
 * real pg-boss queue `TrackerModule` registers a handler against — no test
 * here mocks `JobQueueService`. The provider override exists only because
 * `AppModule` wires up `LlmModule` regardless; the tracker makes no LLM call.
 */
const { db: adminDb, pool: adminPool } = createAdminDb();
const { pool: appPool } = createTestDb();

const USER_A = 'e2e2e2e2-0000-4000-8000-00000000e21a';
const USER_B = 'f2f2f2f2-0000-4000-8000-00000000f21b';

let app: INestApplication;
let sessions: SessionService;
let jobQueue: JobQueueService;

const fake = new FakeProvider();
const delegatingProvider: LlmProvider = {
  complete: (params: ProviderCompletionParams): Promise<ProviderCompletionResult> =>
    fake.complete(params),
};

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

function pasteVacancy(cookie: string, rawText = 'Backend Engineer, remote') {
  return request(app.getHttpServer()).post('/me/vacancies').set('Cookie', cookie).send({ rawText });
}

function createApplication(cookie: string, vacancyId: string) {
  return request(app.getHttpServer()).post('/me/applications').set('Cookie', cookie).send({ vacancyId });
}

function transition(cookie: string, id: string, status: string, note?: string) {
  return request(app.getHttpServer())
    .post(`/me/applications/${id}/transition`)
    .set('Cookie', cookie)
    .send({ status, ...(note ? { note } : {}) });
}

function getApplication(cookie: string, id: string) {
  return request(app.getHttpServer()).get(`/me/applications/${id}`).set('Cookie', cookie);
}

function listApplications(cookie: string, status?: string) {
  return request(app.getHttpServer())
    .get(`/me/applications${status ? `?status=${status}` : ''}`)
    .set('Cookie', cookie);
}

async function eventsFor(applicationId: string) {
  return adminDb
    .select()
    .from(schema.applicationEvents)
    .where(eq(schema.applicationEvents.applicationId, applicationId));
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 5000, intervalMs = 100): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Condition not met within ${timeoutMs}ms`);
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
  jobQueue = app.get(JobQueueService);
});

afterAll(async () => {
  for (const userId of [USER_A, USER_B]) {
    await adminDb.delete(schema.users).where(eq(schema.users.id, userId));
  }
  await app?.close();
  await adminPool.end();
  await appPool.end();
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

describe('starting to track a vacancy (FR22)', () => {
  it('creates a sourced application and records a created event', async () => {
    const cookie = await sessionCookieFor(USER_A);
    const { body: vacancy } = await pasteVacancy(cookie).expect(201);

    const res = await createApplication(cookie, vacancy.id).expect(201);
    expect(res.body).toMatchObject({ vacancyId: vacancy.id, status: 'sourced', appliedAt: null });

    const events = await eventsFor(res.body.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ eventType: 'created', payload: { vacancyId: vacancy.id } });
  });

  it('refuses tracking someone else\'s vacancy with 404, not 403', async () => {
    const { body: vacancy } = await pasteVacancy(await sessionCookieFor(USER_A)).expect(201);
    await createApplication(await sessionCookieFor(USER_B), vacancy.id).expect(404);
  });

  it('refuses an unauthenticated create', async () => {
    await request(app.getHttpServer()).post('/me/applications').send({ vacancyId: 'x' }).expect(401);
  });

  it('refuses a malformed vacancyId with 400, not a raw Postgres error', async () => {
    await createApplication(await sessionCookieFor(USER_A), 'not-a-uuid').expect(400);
  });

  it('answers someone else\'s application with 404 on GET, not 403', async () => {
    const cookieA = await sessionCookieFor(USER_A);
    const { body: vacancy } = await pasteVacancy(cookieA).expect(201);
    const { body: application } = await createApplication(cookieA, vacancy.id).expect(201);

    await getApplication(await sessionCookieFor(USER_B), application.id).expect(404);
  });
});

describe('listing applications (FR22)', () => {
  it('filters by status, and refuses an unknown one with 400', async () => {
    const cookie = await sessionCookieFor(USER_A);
    const { body: vacancyA } = await pasteVacancy(cookie, 'Vacancy one').expect(201);
    const { body: vacancyB } = await pasteVacancy(cookie, 'Vacancy two').expect(201);
    const { body: applied } = await createApplication(cookie, vacancyA.id).expect(201);
    const { body: sourced } = await createApplication(cookie, vacancyB.id).expect(201);
    await transition(cookie, applied.id, 'applied').expect(201);

    const filtered = await listApplications(cookie, 'applied').expect(200);
    expect(filtered.body.map((a: { id: string }) => a.id)).toEqual([applied.id]);

    const all = await listApplications(cookie).expect(200);
    expect(all.body.map((a: { id: string }) => a.id).sort()).toEqual([applied.id, sourced.id].sort());

    await listApplications(cookie, 'not_a_status').expect(400);
  });
});

describe('status transitions (FR22)', () => {
  it('moves status, sets appliedAt, and writes a status_changed event', async () => {
    const cookie = await sessionCookieFor(USER_A);
    const { body: vacancy } = await pasteVacancy(cookie).expect(201);
    const { body: application } = await createApplication(cookie, vacancy.id).expect(201);

    const res = await transition(cookie, application.id, 'applied', 'Applied via referral').expect(201);
    expect(res.body.status).toBe('applied');
    expect(res.body.appliedAt).not.toBeNull();

    const events = await eventsFor(application.id);
    const statusChanged = events.find((e) => e.eventType === 'status_changed');
    expect(statusChanged).toMatchObject({
      payload: { fromStatus: 'sourced', toStatus: 'applied', note: 'Applied via referral' },
    });
  });

  it('refuses an invalid transition with 400 and writes no event', async () => {
    const cookie = await sessionCookieFor(USER_A);
    const { body: vacancy } = await pasteVacancy(cookie).expect(201);
    const { body: application } = await createApplication(cookie, vacancy.id).expect(201);

    await transition(cookie, application.id, 'offer').expect(400);

    const events = await eventsFor(application.id);
    expect(events.map((e) => e.eventType)).toEqual(['created']);
  });

  it('accepts no further transition once terminal', async () => {
    const cookie = await sessionCookieFor(USER_A);
    const { body: vacancy } = await pasteVacancy(cookie).expect(201);
    const { body: application } = await createApplication(cookie, vacancy.id).expect(201);
    await transition(cookie, application.id, 'rejected').expect(201);

    await transition(cookie, application.id, 'applied').expect(400);
    await transition(cookie, application.id, 'withdrawn').expect(400);
  });

  it('refuses transitioning someone else\'s application with 404, not 403', async () => {
    const cookieA = await sessionCookieFor(USER_A);
    const { body: vacancy } = await pasteVacancy(cookieA).expect(201);
    const { body: application } = await createApplication(cookieA, vacancy.id).expect(201);

    await transition(await sessionCookieFor(USER_B), application.id, 'applied').expect(404);
  });

  it('the conditional update refuses a write once another transaction already changed the status', async () => {
    // A race via two concurrent HTTP requests can't be made to land
    // reliably against a fast local database and a single in-process test —
    // Node's event loop doesn't guarantee the interleaving. This instead
    // drives the exact SQL guard tracker.service.ts's transition() relies on
    // (`WHERE id = $1 AND status = $2`) directly, using two real locked
    // connections so Postgres itself does the serializing.
    const cookie = await sessionCookieFor(USER_A);
    const { body: vacancy } = await pasteVacancy(cookie).expect(201);
    const { body: application } = await createApplication(cookie, vacancy.id).expect(201);

    const clientA = await appPool.connect();
    const clientB = await appPool.connect();
    try {
      await clientA.query('BEGIN');
      await clientA.query("SELECT set_config('app.current_user_id', $1, true)", [USER_A]);
      const first = await clientA.query(
        "UPDATE applications SET status = 'applied' WHERE id = $1 AND status = 'sourced' RETURNING id",
        [application.id],
      );
      expect(first.rowCount).toBe(1);

      // Targets the same row while clientA still holds it — this blocks on
      // clientA's row lock rather than racing past it.
      await clientB.query('BEGIN');
      await clientB.query("SELECT set_config('app.current_user_id', $1, true)", [USER_A]);
      const secondPromise = clientB.query(
        "UPDATE applications SET status = 'rejected' WHERE id = $1 AND status = 'sourced' RETURNING id",
        [application.id],
      );

      await clientA.query('COMMIT');
      const second = await secondPromise;
      // Once unblocked, Postgres re-evaluates the WHERE clause against the
      // now-committed row: status is 'applied', not 'sourced', so this
      // UPDATE matches nothing — exactly the zero-rows case transition()
      // turns into a 409.
      expect(second.rowCount).toBe(0);
      await clientB.query('COMMIT');
    } finally {
      clientA.release();
      clientB.release();
    }
  });
});

describe('the follow-up reminder — pg-boss\'s first real consumer (T21)', () => {
  it('enqueues a delayed job, roughly 14 days out, when reaching applied', async () => {
    const cookie = await sessionCookieFor(USER_A);
    const { body: vacancy } = await pasteVacancy(cookie).expect(201);
    const { body: application } = await createApplication(cookie, vacancy.id).expect(201);

    await transition(cookie, application.id, 'applied').expect(201);

    const rows = await adminDb.execute(
      sql`SELECT start_after, data FROM pgboss.job WHERE name = ${JOB_NAMES.TRACKER_FOLLOW_UP} AND data->>'applicationId' = ${application.id}`,
    );
    expect(rows.rows).toHaveLength(1);
    const row = rows.rows[0] as { start_after: string; data: { applicationId: string; userId: string } };
    expect(row.data).toEqual({ applicationId: application.id, userId: USER_A });

    const delayMs = new Date(row.start_after).getTime() - Date.now();
    // 14 days, generously bounded either side for test runtime.
    expect(delayMs).toBeGreaterThan(13 * 24 * 60 * 60 * 1000);
    expect(delayMs).toBeLessThan(15 * 24 * 60 * 60 * 1000);
  });

  it('writes follow_up_due when the reminder fires and status is still applied', async () => {
    const cookie = await sessionCookieFor(USER_A);
    const { body: vacancy } = await pasteVacancy(cookie).expect(201);
    const { body: application } = await createApplication(cookie, vacancy.id).expect(201);
    await transition(cookie, application.id, 'applied').expect(201);

    // Exercises the exact handler TrackerModule registered, via a second,
    // short-delay job on the same queue — the production 14-day job from
    // the transition above stays queued and irrelevant to this test.
    await jobQueue.enqueue(JOB_NAMES.TRACKER_FOLLOW_UP, { applicationId: application.id, userId: USER_A }, { startAfter: 1 });

    await waitFor(async () => {
      const events = await eventsFor(application.id);
      return events.some((e) => e.eventType === 'follow_up_due');
    }, 10000);
  }, { timeout: 20000, retry: 2 }); // must exceed the 10000ms waitFor ceiling above; retry tolerates the same cross-file job-poller raciness retrieval.spec.ts documents

  it('does not write follow_up_due if status changed before the reminder fired', async () => {
    const cookie = await sessionCookieFor(USER_A);
    const { body: vacancy } = await pasteVacancy(cookie).expect(201);
    const { body: application } = await createApplication(cookie, vacancy.id).expect(201);
    await transition(cookie, application.id, 'applied').expect(201);
    await transition(cookie, application.id, 'interview_scheduled').expect(201);

    const jobId = await jobQueue.enqueue(
      JOB_NAMES.TRACKER_FOLLOW_UP,
      { applicationId: application.id, userId: USER_A },
      { startAfter: 1 },
    );

    await waitFor(async () => {
      const rows = await adminDb.execute(sql`SELECT state FROM pgboss.job WHERE id = ${jobId}`);
      const row = rows.rows[0] as { state: string } | undefined;
      return row?.state === 'completed';
    }, 10000);

    const events = await eventsFor(application.id);
    expect(events.some((e) => e.eventType === 'follow_up_due')).toBe(false);
  }, { timeout: 20000, retry: 2 }); // must exceed the 10000ms waitFor ceiling above; retry tolerates the same cross-file job-poller raciness retrieval.spec.ts documents
});

describe('a broken job queue does not turn a committed transition into a failure', () => {
  it('still answers 201 when enqueueing the reminder throws', async () => {
    // A separate app instance with JobQueueService replaced by a stub whose
    // enqueue always throws — the one way to actually exercise the
    // try/catch in tracker.service.ts's transition() rather than just
    // reading it.
    const throwingJobQueue = {
      enqueue: () => {
        throw new Error('pg-boss unavailable (simulated)');
      },
      registerHandler: async () => 'stub-handler-id',
    };

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(AnthropicProvider)
      .useValue(delegatingProvider)
      .overrideProvider(JobQueueService)
      .useValue(throwingJobQueue)
      .compile();

    const brokenApp = moduleRef.createNestApplication();
    brokenApp.use(cookieParser());
    await brokenApp.init();
    const brokenSessions = brokenApp.get(SessionService);

    try {
      const captured: string[] = [];
      const fakeRes = {
        cookie(name: string, value: string) {
          captured.push(`${name}=${value}`);
          return this;
        },
      };
      await brokenSessions.issue(fakeRes as never, USER_A);
      const cookie = captured.find((c) => c.startsWith(`${SESSION_COOKIE}=`))!;

      const { body: vacancy } = await request(brokenApp.getHttpServer())
        .post('/me/vacancies')
        .set('Cookie', cookie)
        .send({ rawText: 'Backend Engineer, remote' })
        .expect(201);
      const { body: application } = await request(brokenApp.getHttpServer())
        .post('/me/applications')
        .set('Cookie', cookie)
        .send({ vacancyId: vacancy.id })
        .expect(201);

      const res = await request(brokenApp.getHttpServer())
        .post(`/me/applications/${application.id}/transition`)
        .set('Cookie', cookie)
        .send({ status: 'applied' })
        .expect(201);
      expect(res.body.status).toBe('applied');

      // The write is real despite the enqueue failure — this is the claim
      // the fix makes, not just "no 500".
      const events = await eventsFor(application.id);
      expect(events.some((e) => e.eventType === 'status_changed')).toBe(true);
    } finally {
      await brokenApp.close();
    }
  });
});
