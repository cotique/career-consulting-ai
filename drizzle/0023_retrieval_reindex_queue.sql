-- Retrieval infrastructure. Same reasoning as 0016/0019: pgboss.create_queue()
-- does real DDL and runs as its caller, and app_user has no CREATE rights —
-- every queue is provisioned here, once, through the admin connection.
--
-- retrieval-reindex is the manually-triggered chunk+embed job (POST
-- /me/retrieval/reindex) — see src/retrieval/retrieval.service.ts and
-- src/jobs/job-name.ts, which this migration must stay in sync with.
SELECT pgboss.create_queue('retrieval-reindex', '{}'::json);
