-- Row-level security (NFR5 defense-in-depth half). Policies key off the
-- `app.current_user_id` session variable, which the app sets per-request
-- via `SET LOCAL` once auth exists (T12) — see docs/plans/epic1-data-layer.md.
-- FORCE ROW LEVEL SECURITY is required on every table, not just ENABLE:
-- without FORCE, Postgres exempts the table owner (the role our app
-- connects as) from RLS entirely, which would make these policies a no-op
-- for our own connection.

ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "users" FORCE ROW LEVEL SECURITY;
CREATE POLICY "user_owns_row" ON "users"
  USING ("id" = current_setting('app.current_user_id', true)::uuid);

ALTER TABLE "auth_identities" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "auth_identities" FORCE ROW LEVEL SECURITY;
CREATE POLICY "user_owns_row" ON "auth_identities"
  USING ("user_id" = current_setting('app.current_user_id', true)::uuid);

ALTER TABLE "user_profiles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user_profiles" FORCE ROW LEVEL SECURITY;
CREATE POLICY "user_owns_row" ON "user_profiles"
  USING ("user_id" = current_setting('app.current_user_id', true)::uuid);

ALTER TABLE "resumes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "resumes" FORCE ROW LEVEL SECURITY;
CREATE POLICY "user_owns_row" ON "resumes"
  USING ("user_id" = current_setting('app.current_user_id', true)::uuid);

ALTER TABLE "resume_extractions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "resume_extractions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "user_owns_row" ON "resume_extractions"
  USING ("resume_id" IN (
    SELECT "id" FROM "resumes" WHERE "user_id" = current_setting('app.current_user_id', true)::uuid
  ));

ALTER TABLE "vacancies" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "vacancies" FORCE ROW LEVEL SECURITY;
CREATE POLICY "user_owns_row" ON "vacancies"
  USING ("user_id" = current_setting('app.current_user_id', true)::uuid);

ALTER TABLE "vacancy_scores" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "vacancy_scores" FORCE ROW LEVEL SECURITY;
CREATE POLICY "user_owns_row" ON "vacancy_scores"
  USING ("vacancy_id" IN (
    SELECT "id" FROM "vacancies" WHERE "user_id" = current_setting('app.current_user_id', true)::uuid
  ));

ALTER TABLE "tailored_documents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tailored_documents" FORCE ROW LEVEL SECURITY;
CREATE POLICY "user_owns_row" ON "tailored_documents"
  USING ("vacancy_id" IN (
    SELECT "id" FROM "vacancies" WHERE "user_id" = current_setting('app.current_user_id', true)::uuid
  ));

ALTER TABLE "applications" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "applications" FORCE ROW LEVEL SECURITY;
CREATE POLICY "user_owns_row" ON "applications"
  USING ("user_id" = current_setting('app.current_user_id', true)::uuid);

ALTER TABLE "application_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "application_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY "user_owns_row" ON "application_events"
  USING ("application_id" IN (
    SELECT "id" FROM "applications" WHERE "user_id" = current_setting('app.current_user_id', true)::uuid
  ));

ALTER TABLE "llm_usage_logs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "llm_usage_logs" FORCE ROW LEVEL SECURITY;
CREATE POLICY "user_owns_row" ON "llm_usage_logs"
  USING ("user_id" = current_setting('app.current_user_id', true)::uuid);
