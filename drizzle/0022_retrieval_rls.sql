-- Row-level security for the new chunk tables, direct user_id form (the
-- hardened pattern 0006 established, not 0001's original ungated one).
ALTER TABLE "resume_extraction_chunks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "resume_extraction_chunks" FORCE ROW LEVEL SECURITY;
CREATE POLICY "user_owns_row" ON "resume_extraction_chunks"
  USING ("user_id" = NULLIF(current_setting('app.current_user_id', true), '')::uuid)
  WITH CHECK ("user_id" = NULLIF(current_setting('app.current_user_id', true), '')::uuid);

ALTER TABLE "vacancy_chunks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "vacancy_chunks" FORCE ROW LEVEL SECURITY;
CREATE POLICY "user_owns_row" ON "vacancy_chunks"
  USING ("user_id" = NULLIF(current_setting('app.current_user_id', true), '')::uuid)
  WITH CHECK ("user_id" = NULLIF(current_setting('app.current_user_id', true), '')::uuid);
