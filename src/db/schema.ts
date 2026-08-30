import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

// Enums — this file is the source of truth for allowed values; the rules they
// obey live in docs/ARCHITECTURE.md under "Data model".
export const authProviderEnum = pgEnum('auth_provider', [
  'telegram',
  'google',
  'microsoft',
  'email',
]);
export const notificationChannelEnum = pgEnum('notification_channel', [
  'email',
  'telegram',
  'web_push',
]);
export const vacancySourceTypeEnum = pgEnum('vacancy_source_type', [
  'paste',
  'ats_greenhouse',
  'ats_lever',
  'ats_ashby',
]);
export const applicationStatusEnum = pgEnum('application_status', [
  'sourced',
  'applied',
  'interview_scheduled',
  'interview_completed',
  'offer',
  'rejected',
  'withdrawn',
]);
export const documentTypeEnum = pgEnum('document_type', ['resume', 'cover_letter']);

// Who produced a piece of generated content, and whether it has been approved.
// Added 2026-08-09 (architecture review): the phase-4 consultant review queue
// needs the author/approver distinction to exist from the start — retrofitting
// it onto content that already exists is the painful version.
export const createdByEnum = pgEnum('created_by', ['user', 'agent', 'consultant']);
export const contentStateEnum = pgEnum('content_state', ['draft', 'approved']);

// --- Auth & profile ---------------------------------------------------

// `tenant_id` (nullable, no FK, no index) appears on user-owned domain tables
// as a reserved column: the phase-4 consultant platform introduces tenants, and
// adding the column later to populated tables is the expensive version. Nothing
// reads or writes it today — deliberately a convention, not a feature. There is
// no `tenants` table until that phase, hence no foreign key.

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name'),
  tenantId: uuid('tenant_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const authIdentities = pgTable(
  'auth_identities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: authProviderEnum('provider').notNull(),
    // The provider's immutable subject identifier — Google `sub`, Microsoft
    // `oid:tid`. Never an email: emails change hands and the Microsoft claim
    // isn't reliably verified, so matching on one is an account-takeover path.
    externalId: text('external_id').notNull(),
    // Stored for display only. Never used to find or link an account (T42).
    email: text('email'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    // The lookup key, and insurance against a race creating two identities
    // for the same provider subject.
    providerSubjectUnique: uniqueIndex('auth_identities_provider_external_id_key').on(
      table.provider,
      table.externalId,
    ),
  }),
);

export const userProfiles = pgTable('user_profiles', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  targetRoles: text('target_roles').array(),
  locations: text('locations').array(),
  preferences: jsonb('preferences'),
  // Conversation/UI language (BCP 47). Deliverable language is deliberately
  // NOT stored here — it's derived per-vacancy from the job description.
  uiLanguage: text('ui_language'),
  // [{ countryCode, city?, remote }] — where the user is looking. Europe-capped
  // at launch (validated in the onboarding layer, not by a DB constraint, so
  // widening the market list later is a code change, not a migration).
  targetMarkets: jsonb('target_markets'),
  timezone: text('timezone'),
  preferredNotificationTime: text('preferred_notification_time'),
  notificationChannel: notificationChannelEnum('notification_channel')
    .default('email')
    .notNull(),
});

// --- Resumes (raw/structured split) -----------------------------------

export const resumes = pgTable('resumes', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  blobStoragePath: text('blob_storage_path').notNull(),
  mimeType: text('mime_type').notNull(),
  isActive: boolean('is_active').default(true).notNull(),
  uploadedAt: timestamp('uploaded_at', { withTimezone: true }).defaultNow().notNull(),
});

// `user_id` is denormalized onto every child table (added 2026-08-09,
// architecture review): RLS policies that reach the owner through a join don't
// compose and get expensive as the graph deepens. Every user-owned row carries
// its owner directly, so each policy is a single column comparison.
export const resumeExtractions = pgTable('resume_extractions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  resumeId: uuid('resume_id')
    .notNull()
    .references(() => resumes.id, { onDelete: 'cascade' }),
  structuredJson: jsonb('structured_json').notNull(),
  modelUsed: text('model_used').notNull(),
  // Convention from ARCHITECTURE.md's data-model rules, missing here until 2026-08-10 while
  // vacancy_scores and tailored_documents both had it: self-audit compares
  // generated output across prompt revisions, and an extraction whose prompt
  // version is unknown can't take part in that comparison.
  promptVersion: text('prompt_version'),
  tenantId: uuid('tenant_id'),
  extractedAt: timestamp('extracted_at', { withTimezone: true }).defaultNow().notNull(),
});

// --- Vacancies and scoring ---------------------------------------------

export const vacancies = pgTable(
  'vacancies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    sourceType: vacancySourceTypeEnum('source_type').notNull(),
    sourceUrl: text('source_url'),
    rawText: text('raw_text').notNull(),
    // Normalised sha-256 of `raw_text` (T16). Deliberately NOT unique: the same
    // posting pasted twice is routed to the row that already exists, and a
    // unique constraint would turn that into an error the caller has to
    // interpret. Nullable because rows predating this column have no hash and
    // must keep working — expand/contract.
    rawTextHash: text('raw_text_hash'),
    structuredJson: jsonb('structured_json'),
    // Which prompt produced `structured_json`. Same convention, and the same
    // reason, as `resume_extractions.prompt_version`: a structure whose prompt
    // version is unknown cannot take part in a self-audit comparison. Null
    // until the vacancy has been parsed.
    parsePromptVersion: text('parse_prompt_version'),
    companyName: text('company_name'),
    title: text('title'),
    // ISO 3166-1 alpha-2. Market-specific behavior (CV conventions, language,
    // legal norms) keys off this rather than parsing free-text locations.
    countryCode: text('country_code'),
    tenantId: uuid('tenant_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    // The duplicate lookup on paste is always "this user, this hash" — the
    // owner column leads because every query carries it and RLS filters on it.
    userRawTextHashIdx: index('vacancies_user_id_raw_text_hash_idx').on(
      table.userId,
      table.rawTextHash,
    ),
  }),
);

export const vacancyScores = pgTable('vacancy_scores', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  vacancyId: uuid('vacancy_id')
    .notNull()
    .references(() => vacancies.id, { onDelete: 'cascade' }),
  score: numeric('score').notNull(),
  verificationNotes: text('verification_notes'),
  modelUsed: text('model_used').notNull(),
  promptVersion: text('prompt_version').notNull(),
  tenantId: uuid('tenant_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

// --- Output personalization --------------------------------------------

// Generated content carries the owner/author split: `user_id` is who the
// document belongs to (and what RLS keys off), `created_by` is who produced
// it, `state` is whether it has been approved. Same three columns apply to any
// future generated-content table (STAR cases, outreach drafts).
export const tailoredDocuments = pgTable('tailored_documents', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  vacancyId: uuid('vacancy_id')
    .notNull()
    .references(() => vacancies.id, { onDelete: 'cascade' }),
  resumeId: uuid('resume_id')
    .notNull()
    .references(() => resumes.id, { onDelete: 'cascade' }),
  docType: documentTypeEnum('doc_type').notNull(),
  content: text('content').notNull(),
  version: integer('version').default(1).notNull(),
  createdBy: createdByEnum('created_by').default('agent').notNull(),
  state: contentStateEnum('state').default('draft').notNull(),
  modelUsed: text('model_used').notNull(),
  promptVersion: text('prompt_version').notNull(),
  tenantId: uuid('tenant_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

// --- Application tracker ------------------------------------------------

export const applications = pgTable('applications', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  vacancyId: uuid('vacancy_id')
    .notNull()
    .references(() => vacancies.id, { onDelete: 'cascade' }),
  status: applicationStatusEnum('status').default('sourced').notNull(),
  appliedAt: timestamp('applied_at', { withTimezone: true }),
  tenantId: uuid('tenant_id'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const applicationEvents = pgTable('application_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  applicationId: uuid('application_id')
    .notNull()
    .references(() => applications.id, { onDelete: 'cascade' }),
  eventType: text('event_type').notNull(),
  payload: jsonb('payload'),
  tenantId: uuid('tenant_id'),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).defaultNow().notNull(),
});

// --- Costs ---------------------------------------------------------------

export const llmUsageLogs = pgTable(
  'llm_usage_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    taskType: text('task_type').notNull(),
    // Recorded here as well as on generated content: without it, a cost
    // regression introduced by a prompt edit can't be attributed to the version
    // that caused it, and the attribution can't be reconstructed after the fact.
    promptVersion: text('prompt_version').notNull(),
    // Groups the calls of one conversation so turns and spend can be capped per
    // conversation, not just per month. Nullable: most calls are one-shot.
    conversationId: text('conversation_id'),
    // Which attempt of one logical call this row is. A structured-output retry
    // is a second paid call but not a second conversation turn, so turn caps
    // count attempt 1 only — without this column they would charge the user a
    // turn for the model's failure to follow a schema.
    attempt: integer('attempt').notNull().default(1),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    inputTokens: integer('input_tokens').notNull(),
    outputTokens: integer('output_tokens').notNull(),
    costEstimate: numeric('cost_estimate').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    // Conversation accounting re-reads every row of a conversation before each
    // turn. Partial: most calls are one-shot, and indexing their NULLs would
    // cost space for rows this lookup never touches.
    conversationIdx: index('llm_usage_logs_conversation_id_idx')
      .on(table.conversationId)
      .where(sql`${table.conversationId} IS NOT NULL`),
  }),
);
