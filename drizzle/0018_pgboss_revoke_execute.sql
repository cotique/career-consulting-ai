-- T20, code-review follow-up. 0017's comment claimed "no EXECUTE grant, for
-- the same reason: app_user never calls either function" — true in intent,
-- but not what actually stopped it: Postgres grants EXECUTE on a newly
-- created function to PUBLIC by default, so app_user already had it. The
-- real (and only) protection was app_user lacking CREATE on the schema,
-- which is what makes create_queue()'s internal CREATE TABLE fail. If CREATE
-- were ever granted for an unrelated reason, that default PUBLIC EXECUTE
-- would hand app_user a path to arbitrary DDL through a function call with
-- no gate of its own. This makes the invariant 0017 described actually true,
-- rather than true only incidentally.
REVOKE EXECUTE ON FUNCTION pgboss.create_queue(text, json) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION pgboss.delete_queue(text) FROM PUBLIC;
