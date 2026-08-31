import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import PgBoss from 'pg-boss';
import { SecretsService } from '../config/secrets.service';
import type { JobName } from './job-name';

/**
 * The single entry point for background jobs (T20). Enqueues, registers
 * handlers, and schedules cron — everything else in the app talks to pg-boss
 * only through this.
 */
@Injectable()
export class JobQueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(JobQueueService.name);
  private boss: PgBoss | undefined;

  constructor(private readonly secrets: SecretsService) {}

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
      await this.boss.stop({ graceful: true });
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
}
