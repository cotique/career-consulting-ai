import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import PgBoss from 'pg-boss';
import type { Pool } from 'pg';
import { PG_POOL } from '../db/db.module';
import { SecretsService } from '../config/secrets.service';
import type { JobName } from './job-name';

/**
 * A job older than this, still active, was abandoned mid-handler by a
 * process that never got to call onModuleDestroy — killed outright, or
 * (observed directly, T22) torn down by a test runner before pg-boss's own
 * 30s graceful-shutdown wait could finish. pg-boss's own failWip()
 * mechanism exists for exactly this and should catch most cases on its own,
 * but does not reliably run when the owning process itself never shuts down
 * cleanly — this sweep is the backstop for what that leaves behind. A real
 * job taking longer than this to run is not expected at this scale; revisit
 * the threshold if one legitimately does.
 */
const STALE_ACTIVE_THRESHOLD_MS = 2 * 60 * 1000;

/**
 * The single entry point for background jobs (T20). Enqueues, registers
 * handlers, and schedules cron — everything else in the app talks to pg-boss
 * only through this.
 */
@Injectable()
export class JobQueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(JobQueueService.name);
  private boss: PgBoss | undefined;

  constructor(
    private readonly secrets: SecretsService,
    @Inject(PG_POOL) private readonly pool: Pool,
  ) {}

  /**
   * `migrate: false`: `app_user` has no CREATE rights (`drizzle/0002_app_runtime_role.sql`)
   * — the pgboss schema, its tables and every queue are provisioned entirely
   * by migrations (`0015`–`0017`), never by this runtime connection. Without
   * this flag `start()` would attempt pg-boss's own self-migration and fail
   * on the first DDL statement; with it, `start()` calls pg-boss's own
   * `contractor.check()` instead — a plain read that throws loudly on a
   * schema-version mismatch, which is the failure mode worth having here:
   * loud and diagnosable, not a silent permission-denied.
   *
   * `schedule: false`: pg-boss's own cron engine (the "Timekeeper") is off by
   * default `true`, and on `start()` it unconditionally calls
   * `createQueue('__pgboss__send-it')` — a real DDL call through the same
   * function `app_user` must never invoke (see `0017`'s comment), and one
   * this repo never provisioned a partition for. It fails today only because
   * `app_user` lacks `CREATE`, silently, on every boot, logged as a bare pg-boss
   * `error` event. Turning it off makes the current truth explicit instead of
   * incidental: `schedule()` below only proves the row lands in
   * `pgboss.schedule` (see its own doc comment) — nothing delivers it yet.
   * Revisit together: provision `__pgboss__send-it` via a migration, then
   * flip this back on, once a real caller needs cron delivery to work.
   */
  async onModuleInit(): Promise<void> {
    const connectionString = await this.secrets.getSecret('DATABASE_URL');
    this.boss = new PgBoss({ connectionString, schema: 'pgboss', migrate: false, schedule: false });
    this.boss.on('error', (err) => this.logger.error('pg-boss error', err as Error));
    await this.boss.start();
    await this.reclaimStaleActiveJobs();
  }

  async onModuleDestroy(): Promise<void> {
    // Guards two things at once: `onModuleInit` never having completed (so
    // `boss` was never assigned — e.g. a bad `DATABASE_URL` threw before
    // `start()`), and `stop()` itself throwing. Either way this must not
    // propagate: `enableShutdownHooks` (src/main.ts) means an uncaught
    // rejection here forces Nest to hard `process.exit(1)` for the whole
    // app rather than letting the rest of shutdown run.
    if (!this.boss) return;
    try {
      // pg-boss's own default graceful timeout is 30s — too long for this
      // app's actual job durations, and risky on Azure Container Apps'
      // scale-to-zero: a shutdown that takes longer than the platform's own
      // SIGTERM grace period gets force-killed anyway, the exact outcome
      // graceful shutdown exists to avoid. Shortened, not disabled.
      await this.boss.stop({ graceful: true, timeout: 5000 });
    } catch (err) {
      this.logger.error('pg-boss failed to stop gracefully', err as Error);
    }
  }

  /**
   * Enqueues a job. `T` must be identifiers only, never content (NFR7) — a
   * queued payload is at-least-once delivered and can otherwise outlive a
   * user's delete-cascade. This is a documented convention, not a type-level
   * guarantee: nothing here rejects a caller that passes free text. `options`
   * covers retry/delay/expiry — see `PgBoss.SendOptions`.
   */
  enqueue<T extends object>(
    queue: JobName,
    payload: T,
    options?: PgBoss.SendOptions,
  ): Promise<string | null> {
    const boss = this.requireBoss();
    return options ? boss.send(queue, payload, options) : boss.send(queue, payload);
  }

  /**
   * Registers a handler for a queue. pg-boss delivers work in batches
   * (`PgBoss.Job<T>[]`); this runs them one at a time so a caller writes an
   * ordinary per-job handler instead of a batch loop. That per-job isolation
   * is real only because nothing here ever raises `batchSize` above its
   * default of 1 — a throw part-way through this loop fails pg-boss's whole
   * batch, including jobs already handled earlier in it. If a caller ever
   * needs `batchSize > 1`, this loop needs `Promise.allSettled` and per-job
   * `complete`/`fail` calls instead, not just wider throughput. Handlers must
   * be idempotent regardless — pg-boss is at-least-once, so the same job can
   * run twice.
   */
  registerHandler<T extends object>(
    queue: JobName,
    handler: (job: PgBoss.Job<T>) => Promise<void>,
  ): Promise<string> {
    return this.requireBoss().work<T>(queue, async (jobs) => {
      for (const job of jobs) {
        await handler(job);
      }
    });
  }

  /**
   * Inserts a cron row into `pgboss.schedule`. Cron delivery itself is not
   * wired up yet — pg-boss's Timekeeper is disabled (see `onModuleInit`'s
   * `schedule: false`) until `__pgboss__send-it` is provisioned by a
   * migration, so a scheduled job is recorded but nothing currently fires it.
   * `data` must obey the same identifiers-only rule as `enqueue`.
   */
  schedule(queue: JobName, cron: string, data?: object): Promise<void> {
    return this.requireBoss().schedule(queue, cron, data);
  }

  private requireBoss(): PgBoss {
    if (!this.boss) {
      throw new Error('JobQueueService used before onModuleInit ran.');
    }
    return this.boss;
  }

  /**
   * Backstop for a job left active by a process that never shut down
   * cleanly (see the constant's own comment). Runs once, at boot, before
   * this instance starts polling for new work — so it never fights a job
   * this same instance is legitimately still processing (there is none yet).
   * pgboss.* carries no RLS by design (see docs/ARCHITECTURE.md), so a
   * plain pool query is the correct access path here, not withUserContext.
   *
   * `boss.fail()` respects the queue's own retry policy rather than forcing
   * a terminal state — a reclaimed job with retries left moves to `retry`,
   * not straight to `failed`. That is the right default here: the job's
   * real work may genuinely be unfinished, and another attempt (by whatever
   * instance next picks it up) is correct where declaring it dead outright
   * is not. If that next attempt is itself abandoned, this same sweep
   * catches it again on a later boot — self-healing, not a single shot.
   */
  private async reclaimStaleActiveJobs(): Promise<void> {
    const boss = this.requireBoss();
    const staleBefore = new Date(Date.now() - STALE_ACTIVE_THRESHOLD_MS);
    const { rows } = await this.pool.query<{ id: string; name: string }>(
      "SELECT id, name FROM pgboss.job WHERE state = 'active' AND started_on < $1",
      [staleBefore],
    );

    for (const row of rows) {
      await boss.fail(row.name, row.id, {
        reason: 'reclaimed on boot: abandoned by a process that never shut down cleanly',
      });
    }

    if (rows.length > 0) {
      this.logger.warn(
        `Reclaimed ${rows.length} stale active job(s) left over from a previous process.`,
      );
    }
  }
}
