/**
 * Queue names provisioned by migration (see `drizzle/0016_pgboss_queues.sql`).
 * `pgboss.create_queue()` does real DDL and runs as its caller, and `app_user`
 * has no CREATE rights — so a queue must exist before `send()`/`work()` can
 * touch it, and a new one is a migration, never a runtime call. This union is
 * what stops a caller referencing a name nothing ever provisioned.
 */
export const JOB_NAMES = {
  T20_SMOKE_TEST: 't20-smoke-test',
} as const;

export type JobName = (typeof JOB_NAMES)[keyof typeof JOB_NAMES];
