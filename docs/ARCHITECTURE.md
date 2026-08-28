# career-consulting-ai — architecture decisions

*Locked in on 2026-08-07, at the first architecture conversation. These are starting decisions, not an immutable spec — revisited when a reason arises. The requirements they answer to are listed at the end, under the FR/NFR numbers the code cites. Column-level detail is deliberately not here: `src/db/schema.ts` and the migrations under `drizzle/` are the source of truth for shape, and this document holds the rules that shape has to obey.*

## MVP audience

One user (dogfooding), the same way the earlier ad-hoc setup started — but the architecture is designed with expansion in mind, not as a "single-user system."
Specifically, decided to bake in from day one (cheap now, expensive to add later):
- a multi-user data model (`user_id` everywhere, not "I = the only user"),
- usage/token logging on every LLM call (needed both for future billing and for simply understanding costs),
- LLM calls behind a single abstract layer (provider + model + key as parameters, not hardcoded).

The cost model for opening up to other users (BYOK vs hosted with usage-based billing) is deliberately deferred until a second real user shows up. Not needed yet.

## Models/providers

Multi-provider from the start, through a thin abstraction layer — different subtasks (search/scoring vs. text generation vs. retrieval for interview prep) likely want different models by price/quality. Specific models and providers — decide during implementation, not in advance.

## Connectors for MVP

- **Paste input** (text/link to a vacancy) — universal path, LLM parses the structure. The primary method at launch.
- **ATS API** (Greenhouse/Lever/Ashby — official public APIs) — as the first auto-sourcing channel.
- **Job board scrapers (LinkedIn, Indeed, etc.) — deliberately not doing this.** Most major boards' ToS explicitly prohibits scraping, plus it requires constant maintenance as markup changes. Not in the MVP plan.

## State storage

**Postgres + pgvector**, managed (Supabase / Cloud SQL / Neon — the specific choice doesn't matter). One engine covers both relational data (vacancies, scoring, application statuses, usage logs) and vector retrieval (interview case bank, decision memory) — no second service needed.

Files/markdown as the primary store — deliberately NOT repeating this: it's exactly the organic path that produced the earlier ad-hoc setup without a design, and repeating it was ruled out at kickoff.

### Data model

Column lists live in `src/db/schema.ts`. What matters here are the rules that schema obeys, because they are the part a reader cannot infer from the DDL:

- **`user_id` on every user-owned table, including child tables** — denormalised deliberately (2026-08-09 architecture review): an RLS policy that reaches the owner through a join re-runs a subquery per row and stops composing once the graph deepens, so each child table carries its owner directly and every policy is one column comparison.
- **Delete-cascade from `users` on every table with `user_id`**, `llm_usage_logs` included. Deleting a user must be complete, not partial.
- **Raw versus structured**: raw resumes live in blob storage, never in Postgres; the database holds a pointer plus the extracted structure. That split is what lets the raw file be dropped without losing what the system reasons over.
- **Authorization twice over**: row-level ownership at the API layer, plus Postgres RLS as defence in depth, keyed off `app.current_user_id` set per request with `SET LOCAL`.
- **Generated content carries owner, author and state**: `user_id` (what RLS keys off), `created_by` (`user`/`agent`), `state` (`draft`/`approved`).
- **A nullable `tenant_id` is reserved** on user-owned tables, with no FK and no index: nothing reads or writes it, and there is no `tenants` table. Left in place because removing it would be a migration whose only benefit is tidiness.
- **`country_code`** (ISO 3166-1 alpha-2) where market matters, so market-specific behaviour keys off a code rather than parsing free text.
- **Every migration must be safe to have applied while the *previous* version of the code is still running** (expand/contract, decided 2026-08-10). Add a column or table in one migration, switch the code in the release after, drop the old shape only once nothing reads it. A rename is an add, a backfill, and a later drop — never a rename.

  The reason is that **a migration rollback is not a recovery.** Reversing a migration that dropped a column recreates it empty: the data is gone, and the "down" script that looks like an undo is a script that quietly loses information. So the property that protects a deploy is not reversibility but compatibility — if the new revision fails to start, the schema already applied must still serve the revision still running. That holds whether migrations run by hand or from a job, which is why it is a schema rule and not a pipeline setting.

- **Retrieval, when it arrives**: one embedding model across the whole system, with `embedding_model_version` stored beside every vector so a model change is an explicit "this vector is stale" flag rather than a silent decay in search quality. HNSW rather than IVFFlat — the latter needs training on data and behaves poorly on small, growing tables, and at this volume the speed difference would not be noticeable. Nothing in the built code produces a vector yet, so this constrains nothing so far.

## RAG chatbot over the job-search corpus (2026-08-28)

*The first thing that actually produces a vector — everything above this line was reserved space, this is the decision.*

**Scope**: a chat feature answering questions over the user's own job-search material (interview cases, resume-tailoring notes, applications, strategy) — not a general assistant. **Corpus source is the existing markdown files, not a new authoring surface**: they stay the source of truth and get *ingested*, consistent with the standing rule against markdown-as-primary-store (line 29 above) — the searchable copy is chunked text + embedding in Postgres, the `.md` files are never queried live.

- **Storage**: a new table, `corpus_chunks` (`user_id`, `source_path`, `chunk_text`, `embedding vector`, `embedding_model_version`), same Postgres, same pgvector/HNSW setup already reserved for this. No second vector service (Azure AI Search or otherwise) — that would duplicate a capability the schema already budgeted for.
- **Ingestion is job-shaped**: chunking + embedding a folder of markdown is exactly the "slow, failure-prone, worth retrying" work the execution model already reserves for pg-boss, not a synchronous request handler. Re-ingestion is idempotent on `(user_id, source_path, chunk_index)`.
- **Query-time retrieval + generation is the synchronous chat path** (NFR8 — latency-sensitive, nothing gets queued for uniformity): embed the question, pgvector top-k against `corpus_chunks`, assemble context, one generation call.
- **Provider — Azure AI Foundry (the renamed/unified surface, formerly reached as a standalone "Azure OpenAI resource")**, as a second `LlmProvider` implementation (parallel to the already-scoped-but-unbuilt Vertex-EU path in `TRADEOFFS.md`), used for both the embedding and the generation call in this feature specifically. Picked deliberately on the current name rather than the legacy resource type: nothing exists yet, so there is no standalone-resource deployment to later migrate off — building straight on Foundry avoids that migration entirely. The reason for touching it at all is the same kind already on record for choosing Azure hosting: an explicit learning goal (hands-on with Azure's actual AI platform, not just Container Apps/Postgres/Blob), not a technical requirement — the existing Anthropic-direct provider stays the default everywhere else in the system. This is a hosted managed model end to end; nothing here is self-trained or self-hosted.
- **No new deploy surface**: same Container Apps app, same Key Vault for the new provider's key, same rate limiting.
- **The corpus is this application's own data, not a folder somewhere.** What the chat answers over is what the system already holds for that user — extracted resumes, parsed vacancies, scores, tailored documents, applications and their event timeline. Ingestion therefore derives chunks from those rows rather than crawling a filesystem, and nothing outside the database is a source. Two things follow. First, ownership and erasure need no separate treatment: a chunk is derived from a row that already carries `user_id` and already cascades, so the delete path that exists keeps working and NFR6 is not reopened. Second, staleness has a definition rather than a heuristic — a chunk is stale when the row it came from changed, which is observable, instead of being guessed from filenames or dates. Material a user keeps elsewhere enters the way everything else already enters, through the application's own interfaces; there is no ingestion path that reads a machine.

### Resumes and other PII — a separate zone

- Separate **object storage** (S3/GCS-equivalent) for raw resume files, not the shared DB. Encryption at rest, access strictly scoped by `user_id`, no public URLs.
- Split **raw file** vs. **extracted structure** (LLM parsing into JSON) — the structure is used for scoring/matching, the raw file is only for display/regeneration. This split makes it possible to later delete the raw file without losing functionality.
- Delete-cascade from day one: a user must be able to delete their data (resume + everything derived from it) in one action.
- Verify the LLM provider's data-usage policy before relying on "the API tier isn't trained on your data" as a given — don't treat this as a settled fact without checking at implementation time. **Partially discharged 2026-08-09:** data *residency* was checked against the provider's documentation — there is no EU inference geography on the first-party API, so personal data is processed outside the EU today (recorded in `TRADEOFFS.md` with the Vertex `eu` path and a revisit trigger). The training/retention question above is still unchecked.
- Full GDPR compliance — not a blocker for the dogfood stage, but a real question for a lawyer if the audience ever grows beyond "me + a couple of testers," especially with EU users.

## Stack

**TypeScript/Node.** The decision deliberately goes against "I know it more easily" (.NET) — since learning value matters for a side project, and TS is additionally closer to the typical AI/LLM ecosystem (more examples for RAG/pgvector/agent patterns) and closer to what's expected of a startup stack, should the project ever grow beyond dogfooding.

- **Framework — NestJS** (decided while scaffolding): its module system (`@Module()`, explicit imports) makes the modular-monolith boundaries below a first-class, enforced part of the code rather than a convention to remember. Fastify remains usable underneath as NestJS's HTTP adapter if raw request performance ever becomes a bottleneck.
- **ORM — Drizzle**: first-party, documented support for `pgvector` column types and hand-written index SQL, which the data model above leans on — Prisma's support for custom column types has historically meant dropping to raw SQL anyway for exactly those tables.
- **Test runner — Vitest**: native ESM/TS support, minimal config.

## LLM layer

Every model call in the system goes through one service (`src/llm`, NFR11). Nothing else may import a provider SDK, and there is no path for a caller to pass its own instructions.

- **Prompts live as prose, in the repo.** Instruction text is `src/llm/templates/text/*.md`; the TypeScript module beside it holds only metadata (name, version, task type, declared untrusted inputs, token bound). The text ships to `dist` as a build asset (`nest-cli.json`), and the app verifies at boot that every registered template's file resolved — a missing asset is a failed start, not a failure on the first user action.
- **Prompts are versioned by the registry, not by callers.** Each template pins a `version`, which is what lands in `llm_usage_logs.prompt_version` and beside generated content. A test fingerprints each template (prose + token bound + declared inputs) and fails if it changes without a version bump, because a silent edit would make self-audit compare two different prompts under one label.
- **Why in git and not in a database:** a prompt is the trusted half of a model request. Moving it into a runtime-editable row would put a behavior-changing surface outside code review and outside history. The cost of that choice is that editing a prompt requires a deploy — acceptable while the people editing prompts are the people deploying. *Revisit when that stops being true.*
- **Trusted/untrusted separation is structural.** Callers supply untrusted values under labels the template declares; the single rendering path wraps them in data delimiters. Model output is untrusted too — a failed structured-output response is never fed back into the next prompt's instruction half.
- **Failures are typed** (`retryable` / `permanent` / `budget`) so job handlers can map them to retry vs dead-letter without knowing what an SDK error is. **Truncation is its own failure**, distinct from a schema mismatch: a response cut off at the token limit fails validation for a reason no retry can fix, since identical input produces an identically overlong answer. Treating them alike would pay twice and then blame the prompt for a length problem.
- **Documents go to the model whole, not in chunks** — unless their structure is local. A resume's structure is global (the experience list spans pages, dates must be reconciled across sections), so splitting it and merging partial extractions would trade one clear failure for a new class of quiet ones: duplicated roles, entries lost at a seam, contradictory dates. The bound that matters is therefore output size, which is why truncation is detected rather than retried.
- **Spend is bounded at three levels**: per attempt (worst-case cost refused before sending), per conversation (turns and cost), per user per month (NFR2). All of them run before *every* attempt, retries included.

## Execution model

**Hybrid**: on a schedule (periodic sourcing/scoring runs) + on demand (user hits "search now"). Implementation — **pg-boss** inside the same Postgres (own schema), plus **state machines on domain tables** for long-lived processes.

*Revised 2026-08-09 by architecture review — replaces the original self-hosted Temporal choice. Two reasons: an always-on server + its own ops surface is disproportionate for a solo project, and workflow event histories retain payloads outside the app's delete-cascade, which is a GDPR erasure hole. Only the application tracker ever had a genuinely workflow-shaped argument, and a state machine covers it.*

- **No extra container or service** — pg-boss creates its tables in a dedicated schema of the existing Postgres. It provides retries, delayed jobs, and cron.
- **Long-lived processes are state machines**, not workflows: the application lifecycle lives as `applications.status` + an append-only `application_events` timeline. User signals are ordinary API writes; timers are pg-boss delayed/cron jobs that read current state and act.
- **Job payloads carry entity IDs, never content.** Queue rows would otherwise outlive a user's delete-cascade, re-creating the retention hole that motivated the switch. Handlers re-read what they need from the domain tables.
- **Workers are batch-style: wake → drain the queue → exit**, not long-running listeners. The original reason was portability to a scale-to-zero destination; that reason is gone, and the rule stands on the one that survives it — Container Apps scale-to-zero *is* the cost model here, and a listener that never exits keeps a replica alive continuously. So it is a cost requirement rather than a portability one, and no longer forecloses anything: a listener, if it ever turns out simpler, costs money rather than options.
- **Handlers must be idempotent** — pg-boss is at-least-once, so the same job can run twice.
- Latency-sensitive paths (retrieval, chat) stay plain synchronous handlers (NFR8) — nothing gets queued just for uniformity.

## Onboarding / UX

A hybrid wizard, not a plain questionnaire:
- structured steps for hard facts (name, target role/industry, locations, resume),
- one open free-text step ("tell us what you're looking for and what matters") — the LLM parses this into structured preferences and stores it in memory.

## Hosting

**Azure for MVP** (not in parallel with GCP from day one — a deliberate decision not to hedge against a hypothetical future migration that there's nothing yet to compare on price). The reason for the choice is an explicit learning goal (close the Azure skill gap), not technical superiority. Migrating to another cloud (e.g. GCP for price) is a separate decision, to be made after real Azure bills exist, not before.

- **Backend** — Azure Container Apps (container, scale-to-zero) — conceptually the same as Cloud Run/Fly.io, so the image stays portable if a migration is ever needed.
- **DB** — Azure Database for PostgreSQL – Flexible Server. Verify pgvector support on the specific version/region at implementation time, don't treat it as guaranteed in advance.
- **Resumes/raw files** — Azure Blob Storage, a separate container, access policy scoped by `user_id`.
- Frontend (web prototype or Telegram bot) — hosting is decided separately, doesn't block backend work.

## CI/CD

**GitHub** (code) + **GitHub Actions** (CI/CD) — deploy to Azure Container Apps via the official `azure/container-apps-deploy-action`. Considered Azure DevOps Pipelines as an alternative for Azure learning-value, but that didn't apply (the stack is already familiar), so the decision rests on pure practical merits: a wider community/more examples for Node/TS, a generous free tier, no risk of a delayed free-tier grant on a brand-new Azure DevOps organization, and no tying of CI/CD to Azure beyond the deploy step itself.

CI (install/typecheck/lint/build/test) runs on every push. The **deploy job is manually triggered** (`workflow_dispatch`), never automatic on push or merge — a deploy is a deliberate action, not a side effect of merging. It authenticates to Azure through GitHub OIDC federation with no stored credential, refuses any commit whose CI run is not green (a missing run counts as not green), and probes readiness afterwards rather than trusting its own exit code.

## UI: web or mobile

**Web, responsive, no native app at launch.** One codebase, no app store review/delays, instant updates. If a "like an app on the phone" experience is needed later (home-screen icon, offline, push) — **PWA** on top of the same web code, not a separate native build. Native (Swift/Kotlin/React Native) — only if a concrete reason comes up that a PWA can't cover.

## Deliberately deferred (not deciding in advance)

- BYOK vs. hosted billing — until a second user shows up.
- Specific models/providers per task — at implementation time.
- Calendar integration, a full application tracker as a separate service — the tracker is just a DB, calendar — once real pain shows up.
- A full GDPR program — once the audience genuinely expands beyond dogfooding.

## Requirements this was built against

The code cites these numbers in comments and test names; this is where they resolve. Only the requirements the built system actually answers to are listed — the numbering has gaps because the set it came from was larger than what exists.

**Functional**

- **FR1** — sign-in via OAuth/SSO, no self-managed passwords. Google only; the identity layer is provider-agnostic.
- **FR2** — onboarding: structured facts plus one free-text step, parsed by the LLM into preferences and returned for confirmation rather than stored silently.
- **FR3** — the user's timezone and preferred notification time.
- **FR4** — resume upload: the raw file to blob storage, the structure extracted separately. Exactly one resume is active per user; superseded rows are kept so a tailored document can be traced to the version it came from.
- **FR5** — the user can delete or export everything under their account in one action.

**Non-functional**

- **NFR1** — usage and tokens logged on every LLM call.
- **NFR2** — spend capped per attempt, per conversation and per user per month, checked before every attempt including retries.
- **NFR3** — secrets in a managed store, never in the plaintext environment of a deployed app.
- **NFR4** — PII (resumes) encrypted at rest, raw and structured split, access scoped by `user_id`, no public URLs and no SAS tokens.
- **NFR5** — authorization twice: row-level ownership at the API layer, Postgres RLS as defence in depth.
- **NFR6** — delete-cascade and export from the beginning, not bolted on.
- **NFR7** — failure-prone and long-lived work belongs on a Postgres-backed queue with retries, delayed jobs and cron, plus state machines on domain tables.
- **NFR8** — latency-sensitive paths stay plain synchronous calls; nothing is queued for uniformity.
- **NFR10** — a modular monolith, proportional to one developer.
- **NFR11** — every model call through one layer, with prompts versioned by a registry rather than by callers.
- **NFR14** — an account exists only for a provider subject on an operator-managed allow-list, checked before the account is created. Signing in proves identity, not entitlement; an absent list admits nobody.
- **NFR15** — target markets restricted to an explicit European allow-list, with a clear reason on rejection; interface language stored per user as an ISO 639-1 code. Enforced in application code, so widening the list is a code change rather than a migration.
- **NFR16** — retention: no recovery mechanism may outlive a deletion request, which is why blob soft-delete and versioning are off.
