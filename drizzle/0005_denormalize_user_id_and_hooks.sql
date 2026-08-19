CREATE TYPE "public"."content_state" AS ENUM('draft', 'approved');--> statement-breakpoint
CREATE TYPE "public"."created_by" AS ENUM('user', 'agent', 'consultant');--> statement-breakpoint
ALTER TABLE "application_events" ADD COLUMN "user_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "application_events" ADD COLUMN "tenant_id" uuid;--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "tenant_id" uuid;--> statement-breakpoint
ALTER TABLE "resume_extractions" ADD COLUMN "user_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "resume_extractions" ADD COLUMN "tenant_id" uuid;--> statement-breakpoint
ALTER TABLE "tailored_documents" ADD COLUMN "user_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "tailored_documents" ADD COLUMN "created_by" "created_by" DEFAULT 'agent' NOT NULL;--> statement-breakpoint
ALTER TABLE "tailored_documents" ADD COLUMN "state" "content_state" DEFAULT 'draft' NOT NULL;--> statement-breakpoint
ALTER TABLE "tailored_documents" ADD COLUMN "tenant_id" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "tenant_id" uuid;--> statement-breakpoint
ALTER TABLE "vacancies" ADD COLUMN "country_code" text;--> statement-breakpoint
ALTER TABLE "vacancies" ADD COLUMN "tenant_id" uuid;--> statement-breakpoint
ALTER TABLE "vacancy_scores" ADD COLUMN "user_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "vacancy_scores" ADD COLUMN "tenant_id" uuid;--> statement-breakpoint
ALTER TABLE "application_events" ADD CONSTRAINT "application_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resume_extractions" ADD CONSTRAINT "resume_extractions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tailored_documents" ADD CONSTRAINT "tailored_documents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vacancy_scores" ADD CONSTRAINT "vacancy_scores_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;