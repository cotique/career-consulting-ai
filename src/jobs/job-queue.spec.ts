import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SecretsService } from '../config/secrets.service';
import { createAdminDb, createTestDb } from '../db/test-db';
import { JOB_NAMES } from './job-name';
import { JobQueueService } from './job-queue.service';

/**
 * T20 end to end: a real `JobQueueService` against real local Postgres,
 * connecting as `app_user` — the same role and connection string
 * (`DATABASE_URL`) the running app uses, not the admin role. This is what
 * actually falsifies the migration/grants design: a wrong grant, a missing
 * queue, or a schema-version mismatch surfaces in `onModuleInit` itself, via
 * pg-boss's own `contractor.check()`.
 *
 * `t20-smoke-test` is a synthetic queue with no product-facing caller — see
 * docs/ARCHITECTURE.md's Execution model. It exists only to prove the
 * primitives (enqueue/work/retry/delay/schedule) work at all.
 */
const { db: adminDb, pool: adminPool } = createAdminDb();
const { pool: appPool } = createTestDb();

let service: JobQueueService;

interface Marked {
  marker: string;
}

/**
 * Exactly one `registerHandler` call for the whole file, dispatching to
 * whichever test registered a callback for that job's marker — calling
 * `registerHandler` per test would start a second, independent poller
 * competing for the same queue's rows, and whichever poller happened to grab
 * a job would run it, silently starving the other. That is not hypothetical:
 * it is exactly what a per-test `registerHandler` produced here first.
 */
const dispatch = new Map<string, (job: { data: Marked; id: string }) => Promise<void>>();

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 5000, intervalMs = 100): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Condition not met within ${timeoutMs}ms`);
}

describe('job queue (T20)', () => {
  beforeAll(async () => {
    service = new JobQueueService(new SecretsService());
    await service.onModuleInit();
    await service.registerHandler<Marked>(JOB_NAMES.T20_SMOKE_TEST, async (job) => {
      const handler = dispatch.get(job.data.marker);
      if (handler) await handler(job);
    });
  });

  afterAll(async () => {
    await service?.onModuleDestroy();
    await adminPool.end();
    await appPool.end();
  });

  it('app_user genuinely lacks CREATE on pgboss — the actual guarantee migrate:false and 0017 rest on', async () => {
    // The schema-version check alone can't prove this: once the schema is
    // fully migrated, pg-boss's own `contractor.check()` (what `migrate:
    // false` routes onModuleInit through) passes whether or not app_user
    // could have created anything — it never attempts DDL to find out. This
    // is the test that actually attempts the DDL create_queue()'s internals
    // would need, as app_user, and asserts Postgres itself refuses it.
    const client = await appPool.connect();
    try {
      await expect(client.query('CREATE TABLE pgboss.__probe (x int)')).rejects.toThrow(
        /permission denied/i,
      );
    } finally {
      client.release();
    }
  });

  it('enqueues and works a job, round-tripping the payload', async () => {
    const marker = `echo-${Date.now()}`;
    let received: Marked | undefined;
    dispatch.set(marker, async (job) => {
      received = job.data;
    });

    await service.enqueue(JOB_NAMES.T20_SMOKE_TEST, { marker });

    await waitFor(async () => received?.marker === marker);
    expect(received).toEqual({ marker });
  });

  it('retries a failing handler and lands on completed, not failed', async () => {
    const marker = `retry-${Date.now()}`;
    let attempts = 0;
    dispatch.set(marker, async () => {
      attempts += 1;
      if (attempts < 2) throw new Error('deliberate failure to force a retry');
    });

    await service.enqueue(
      JOB_NAMES.T20_SMOKE_TEST,
      { marker },
      { retryLimit: 2, retryDelay: 1 },
    );

    await waitFor(async () => {
      const rows = await adminDb.execute(
        sql`SELECT state FROM pgboss.job WHERE name = ${JOB_NAMES.T20_SMOKE_TEST} AND data->>'marker' = ${marker}`,
      );
      const row = rows.rows[0] as { state: string } | undefined;
      return row?.state === 'completed';
    });

    expect(attempts).toBe(2);
  });

  it('does not run a delayed job until after the delay', async () => {
    const marker = `delayed-${Date.now()}`;
    let firedAt: number | undefined;
    dispatch.set(marker, async () => {
      firedAt = Date.now();
    });

    // pg-boss's default poll interval is ~2s with no push-on-enqueue path, so
    // a near-immediate negative check ("hasn't fired within 500ms") has weak
    // discriminating power — a broken startAfter could still coincidentally
    // miss that window. The real proof is the delta below: a job that fired
    // this close to its startAfter, and not sooner, is not a poll-timing
    // coincidence the way "fired eventually" would be.
    const enqueuedAt = Date.now();
    await service.enqueue(JOB_NAMES.T20_SMOKE_TEST, { marker }, { startAfter: 2 });

    await waitFor(async () => firedAt !== undefined, 6000);
    expect(firedAt! - enqueuedAt).toBeGreaterThanOrEqual(1900);
  });

  it('schedule() inserts the expected cron row — the primitive, not pg-boss’s own timing guarantee', async () => {
    // Deliberately narrow, per docs/ARCHITECTURE.md: pg-boss's Timekeeper
    // (the thing that would actually fire this on a cron tick) is disabled
    // for now (onModuleInit's `schedule: false`) — this proves the row lands
    // in pgboss.schedule, not that anything delivers it yet.
    await service.schedule(JOB_NAMES.T20_SMOKE_TEST, '*/5 * * * *', { marker: 'cron' });

    const rows = await adminDb.execute(
      sql`SELECT cron, data FROM pgboss.schedule WHERE name = ${JOB_NAMES.T20_SMOKE_TEST}`,
    );
    expect(rows.rows).toEqual([{ cron: '*/5 * * * *', data: { marker: 'cron' } }]);

    // Clean up: an unscheduled queue is the steady state the other tests in
    // this file assume when they run after this one.
    await adminDb.execute(sql`DELETE FROM pgboss.schedule WHERE name = ${JOB_NAMES.T20_SMOKE_TEST}`);
  });
});
