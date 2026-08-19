ALTER TABLE "user_profiles" ADD COLUMN "ui_language" text;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN "target_markets" jsonb;--> statement-breakpoint
CREATE UNIQUE INDEX "auth_identities_provider_external_id_key" ON "auth_identities" USING btree ("provider","external_id");