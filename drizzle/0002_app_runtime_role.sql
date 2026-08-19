-- The migration/admin role (POSTGRES_USER, "jobsearch" locally) is a
-- superuser in the official Postgres Docker image, and superusers always
-- bypass RLS regardless of FORCE ROW LEVEL SECURITY (that only overrides
-- table-owner bypass, not superuser bypass). Discovered while testing T8 —
-- without this, every RLS policy from 0001 is silently a no-op for the
-- app's own connection. The app must run as a separate, non-superuser role.
--
-- Local-dev-only password, same convention as docker-compose.yml's existing
-- POSTGRES_PASSWORD. Prod (Azure Postgres Flexible Server) needs the
-- equivalent non-superuser app role set up separately — see docs/TRADEOFFS.md.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user WITH LOGIN PASSWORD 'localdev_app' NOSUPERUSER NOBYPASSRLS;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
