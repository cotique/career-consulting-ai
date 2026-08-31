-- T20. Same shape as 0002_app_runtime_role.sql, scoped to the pgboss schema:
-- app_user gets ordinary DML on what 0015/0016 already created (send, fetch,
-- complete, fail, schedule are all plain parameterized SQL from pg-boss's JS
-- layer, never a call into create_queue/delete_queue), never CREATE. No
-- EXECUTE grant, for the same reason: app_user never calls either function.
GRANT USAGE ON SCHEMA pgboss TO app_user;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pgboss TO app_user;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
