-- T21. Same reasoning as 0016_pgboss_queues.sql: `pgboss.create_queue()` does
-- real DDL and runs as its caller, and `app_user` has no CREATE rights, so
-- every queue is provisioned here, once, through the admin connection.
--
-- tracker-follow-up is the application tracker's delayed reminder job — see
-- src/tracker/tracker.service.ts and src/jobs/job-name.ts, which this
-- migration must stay in sync with.
SELECT pgboss.create_queue('tracker-follow-up', '{}'::json);
