-- T16. Both columns are nullable and the index is new, so the previously
-- deployed revision keeps working against this schema unchanged.
-- Not CONCURRENTLY: the table is empty at the time of writing, and a
-- concurrent build cannot run inside the migration transaction.
ALTER TABLE "vacancies" ADD COLUMN "raw_text_hash" text;--> statement-breakpoint
ALTER TABLE "vacancies" ADD COLUMN "parse_prompt_version" text;--> statement-breakpoint
CREATE INDEX "vacancies_user_id_raw_text_hash_idx" ON "vacancies" USING btree ("user_id","raw_text_hash");