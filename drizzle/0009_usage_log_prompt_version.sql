-- Added in three steps rather than a bare `ADD COLUMN ... NOT NULL`: rows
-- already exist, and they genuinely predate the column. They are backfilled
-- as 'unknown' instead of being retro-labelled with whatever version happens
-- to be current, which would be a false attribution in the cost history.
ALTER TABLE "llm_usage_logs" ADD COLUMN "prompt_version" text;--> statement-breakpoint
UPDATE "llm_usage_logs" SET "prompt_version" = 'unknown' WHERE "prompt_version" IS NULL;--> statement-breakpoint
ALTER TABLE "llm_usage_logs" ALTER COLUMN "prompt_version" SET NOT NULL;
