CREATE TABLE "resume_extraction_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"resume_extraction_id" uuid NOT NULL,
	"chunk_index" integer DEFAULT 0 NOT NULL,
	"content" text NOT NULL,
	"content_hash" text NOT NULL,
	"embedding" vector(1536),
	"embedding_model" text NOT NULL,
	"tenant_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vacancy_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"vacancy_id" uuid NOT NULL,
	"chunk_index" integer DEFAULT 0 NOT NULL,
	"content" text NOT NULL,
	"content_hash" text NOT NULL,
	"embedding" vector(1536),
	"embedding_model" text NOT NULL,
	"tenant_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "resume_extraction_chunks" ADD CONSTRAINT "resume_extraction_chunks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resume_extraction_chunks" ADD CONSTRAINT "resume_extraction_chunks_resume_extraction_id_resume_extractions_id_fk" FOREIGN KEY ("resume_extraction_id") REFERENCES "public"."resume_extractions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vacancy_chunks" ADD CONSTRAINT "vacancy_chunks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vacancy_chunks" ADD CONSTRAINT "vacancy_chunks_vacancy_id_vacancies_id_fk" FOREIGN KEY ("vacancy_id") REFERENCES "public"."vacancies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "resume_extraction_chunks_source_chunk_idx" ON "resume_extraction_chunks" USING btree ("resume_extraction_id","chunk_index");--> statement-breakpoint
CREATE INDEX "resume_extraction_chunks_embedding_idx" ON "resume_extraction_chunks" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "vacancy_chunks_source_chunk_idx" ON "vacancy_chunks" USING btree ("vacancy_id","chunk_index");--> statement-breakpoint
CREATE INDEX "vacancy_chunks_embedding_idx" ON "vacancy_chunks" USING hnsw ("embedding" vector_cosine_ops);