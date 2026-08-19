-- On a reused pooled connection where `app.current_user_id` was previously
-- set locally (set_config(..., true)) and the transaction ended, Postgres
-- can leave the custom GUC as an empty string rather than truly unset —
-- so `current_setting(..., true)::uuid` throws "invalid input syntax for
-- type uuid" instead of just not matching. NULLIF converts '' to NULL
-- before the cast, so the safe-default-deny behavior (no match) holds
-- either way, instead of erroring. Found while testing T8.
--
-- WITH CHECK is set explicitly alongside USING on every policy (even
-- though the original 0001 policies didn't specify it, relying on
-- Postgres's ALL-command default) — ALTER POLICY doesn't guarantee
-- syncing an implicit WITH CHECK when only USING is given, so this makes
-- both sides explicit rather than relying on unconfirmed default behavior.

ALTER POLICY "user_owns_row" ON "users"
  USING ("id" = NULLIF(current_setting('app.current_user_id', true), '')::uuid)
  WITH CHECK ("id" = NULLIF(current_setting('app.current_user_id', true), '')::uuid);

ALTER POLICY "user_owns_row" ON "auth_identities"
  USING ("user_id" = NULLIF(current_setting('app.current_user_id', true), '')::uuid)
  WITH CHECK ("user_id" = NULLIF(current_setting('app.current_user_id', true), '')::uuid);

ALTER POLICY "user_owns_row" ON "user_profiles"
  USING ("user_id" = NULLIF(current_setting('app.current_user_id', true), '')::uuid)
  WITH CHECK ("user_id" = NULLIF(current_setting('app.current_user_id', true), '')::uuid);

ALTER POLICY "user_owns_row" ON "resumes"
  USING ("user_id" = NULLIF(current_setting('app.current_user_id', true), '')::uuid)
  WITH CHECK ("user_id" = NULLIF(current_setting('app.current_user_id', true), '')::uuid);

ALTER POLICY "user_owns_row" ON "resume_extractions"
  USING ("resume_id" IN (
    SELECT "id" FROM "resumes" WHERE "user_id" = NULLIF(current_setting('app.current_user_id', true), '')::uuid
  ))
  WITH CHECK ("resume_id" IN (
    SELECT "id" FROM "resumes" WHERE "user_id" = NULLIF(current_setting('app.current_user_id', true), '')::uuid
  ));

ALTER POLICY "user_owns_row" ON "vacancies"
  USING ("user_id" = NULLIF(current_setting('app.current_user_id', true), '')::uuid)
  WITH CHECK ("user_id" = NULLIF(current_setting('app.current_user_id', true), '')::uuid);

ALTER POLICY "user_owns_row" ON "vacancy_scores"
  USING ("vacancy_id" IN (
    SELECT "id" FROM "vacancies" WHERE "user_id" = NULLIF(current_setting('app.current_user_id', true), '')::uuid
  ))
  WITH CHECK ("vacancy_id" IN (
    SELECT "id" FROM "vacancies" WHERE "user_id" = NULLIF(current_setting('app.current_user_id', true), '')::uuid
  ));

ALTER POLICY "user_owns_row" ON "tailored_documents"
  USING ("vacancy_id" IN (
    SELECT "id" FROM "vacancies" WHERE "user_id" = NULLIF(current_setting('app.current_user_id', true), '')::uuid
  ))
  WITH CHECK ("vacancy_id" IN (
    SELECT "id" FROM "vacancies" WHERE "user_id" = NULLIF(current_setting('app.current_user_id', true), '')::uuid
  ));

ALTER POLICY "user_owns_row" ON "applications"
  USING ("user_id" = NULLIF(current_setting('app.current_user_id', true), '')::uuid)
  WITH CHECK ("user_id" = NULLIF(current_setting('app.current_user_id', true), '')::uuid);

ALTER POLICY "user_owns_row" ON "application_events"
  USING ("application_id" IN (
    SELECT "id" FROM "applications" WHERE "user_id" = NULLIF(current_setting('app.current_user_id', true), '')::uuid
  ))
  WITH CHECK ("application_id" IN (
    SELECT "id" FROM "applications" WHERE "user_id" = NULLIF(current_setting('app.current_user_id', true), '')::uuid
  ));

ALTER POLICY "user_owns_row" ON "llm_usage_logs"
  USING ("user_id" = NULLIF(current_setting('app.current_user_id', true), '')::uuid)
  WITH CHECK ("user_id" = NULLIF(current_setting('app.current_user_id', true), '')::uuid);
