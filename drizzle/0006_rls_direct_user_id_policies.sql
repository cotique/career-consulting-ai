-- Rewrite the four join-based RLS policies to direct user_id comparisons,
-- now that 0005 denormalized user_id onto every child table.
--
-- Why (2026-08-09 architecture review): a policy that reaches the owner
-- through a subquery re-runs that subquery per row and stops composing once
-- the graph deepens (a policy on a table whose parent policy also joins).
-- A single indexed column comparison is both cheaper and analyzable.
--
-- The NULLIF guard from 0003 is preserved: on a reused pooled connection a
-- previously-set-then-released GUC can come back as '' rather than unset, and
-- ''::uuid throws instead of simply not matching.

ALTER POLICY "user_owns_row" ON "resume_extractions"
  USING ("user_id" = NULLIF(current_setting('app.current_user_id', true), '')::uuid)
  WITH CHECK ("user_id" = NULLIF(current_setting('app.current_user_id', true), '')::uuid);

ALTER POLICY "user_owns_row" ON "vacancy_scores"
  USING ("user_id" = NULLIF(current_setting('app.current_user_id', true), '')::uuid)
  WITH CHECK ("user_id" = NULLIF(current_setting('app.current_user_id', true), '')::uuid);

ALTER POLICY "user_owns_row" ON "tailored_documents"
  USING ("user_id" = NULLIF(current_setting('app.current_user_id', true), '')::uuid)
  WITH CHECK ("user_id" = NULLIF(current_setting('app.current_user_id', true), '')::uuid);

ALTER POLICY "user_owns_row" ON "application_events"
  USING ("user_id" = NULLIF(current_setting('app.current_user_id', true), '')::uuid)
  WITH CHECK ("user_id" = NULLIF(current_setting('app.current_user_id', true), '')::uuid);
