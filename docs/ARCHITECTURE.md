# career-consulting-ai — architecture decisions

What was decided and why, including the decisions that were reversed and what reversed them. Column-level detail is deliberately not here: `src/db/schema.ts` and the migrations under `drizzle/` are the source of truth for shape, and a second description of it would drift.

Everything decided but not built is a checkbox under **TODO** rather than a paragraph in the present tense, which is how a reader ends up looking for code that was never written.

## What is built

Sign-in through Google, an onboarding profile including a free-text step parsed by a model, resume upload with structured extraction, vacancy intake by paste with structured parsing, scoring a parsed vacancy against a profile and resume, a Postgres-backed job queue, an application tracker with a follow-up reminder, retrieval infrastructure over resumes and vacancies (chunking, embedding, similarity search), account export and deletion, and the infrastructure underneath — the LLM layer, per-request database isolation, rate limiting, telemetry and the deployment pipeline.

Document tailoring was dropped from scope entirely, and so is absent from the list below.

## TODO

Decided, shaped for, and not built. Each is specified in the section named; the tables that anticipate them were kept rather than dropped, since removing them would be a migration whose only benefit is tidiness.

- [ ] **Chat itself** — *Retrieval and chat*. Retrieval (chunking, embedding, similarity search over resumes and vacancies) is built; a conversational endpoint generating answers from retrieved chunks is not.

## Data model

The rules that shaped the schema, as opposed to its contents:

- **Every user-owned row carries `user_id` directly**, including child tables that could reach it through a join. Row-level security policies that join do not compose and degrade as the graph deepens, so the column is denormalised on purpose.
- **Row-level security is forced on every table**, keyed off `app.current_user_id` set per request inside a transaction. It is the layer that survives a forgotten `WHERE`, and it applies only if the application connects as a role that cannot bypass it — a database-level property, not a code convention. This is about domain tables specifically: `pgboss.*` (T20) is operational infrastructure with no per-user session — pg-boss's own polling never sets `app.current_user_id` — so it carries no RLS policy at all, by design rather than oversight.
- **Generated content carries who owns it, who produced it and whether it was approved** as three separate columns. Ownership is what security keys off; authorship and state are product facts. Conflating them means a reviewer cannot be distinguished from an author later without a migration.
- **A raw/structured split for anything arriving as a file**: bytes in object storage, extracted structure in the database, a pointer between them. That is what allows the raw thing to be deleted later without losing function.
- **Every migration must be safe to have applied while the previous version of the code is still running.** Add a column in one migration, switch the code in the release after, drop the old shape later. A rename is an add, a backfill and a later drop, never a rename.

  The reason is that **a rollback is not a recovery**. Reversing a migration that dropped a column recreates it empty: the "undo" is the step that loses the data. So what protects a deploy is not reversibility but compatibility with the revision still serving.

  One migration in the history does not meet this rule — `0009` adds a column, backfills it and marks it `NOT NULL` in a single step, which the previous revision would not survive. It is recorded here rather than quietly fixed, because the rule is worth more than the appearance of having always followed it.

### Personal data

Raw resume files live in object storage rather than the database, and are reachable only through an authenticated endpoint. There are no public URLs and no signed links, so access is decided by the session on every read rather than by whoever holds a link.

Deletion and export were built in the first release rather than retrofitted. Deletion removes stored files before database rows, and the order is not stylistic: once the cascade has run there is no record of which files belonged to whom, so a failure after the rows are gone would leave them unreachable and undeletable.

**No recovery mechanism may outlive a deletion request.** That is why blob soft-delete and versioning are switched off — each would quietly reinstate an erased file for the length of its retention window.

## The LLM layer

**Every model call goes through one service, and nothing else imports a provider SDK.** Routing, spend limits, usage accounting and the untrusted-text convention live behind that entry point, so a call made around it escapes all four at once.

- **Prompts are prose files in git behind a versioned registry.** A caller names a template; the version comes from the registry rather than from the caller. A fingerprint test fails when the text changes without the version moving, because comparing outputs across an unlabelled prompt change produces a conclusion about the world that is really a conclusion about the prompt.
- **Trusted instructions and untrusted content are separated in the type system**, not by caller discipline, and one rendering path wraps untrusted text in delimiters. Model output counts as untrusted on the way back: a response that fails validation is never fed into the instruction half of the retry — only the validation errors are, and those are escaped, because they quote what was received.
- **Structured output is validated against a schema with one retry**, scoped to schema conformance. A response cut off at the token limit is detected separately and not retried, because identical input produces an identically overlong answer: retrying pays twice and then blames the prompt for a length problem.
- **Spend stops rather than being reported.** Three bounds: the worst case of a single attempt, computed before it is sent; a per-user monthly cap; and a per-conversation turn count. All are checked before every attempt, since a retry is another paid call. A validation retry costs money but does not consume a conversation turn — the model failing to follow a schema is not something to charge to the person.
- **Usage rows are written on the layer's own connection**, never the caller's. When they shared one, a failed call rolled back the record of money already spent — and the monthly cap is computed from exactly those rows, so failures cost real money and counted for nothing.
- **A typed failure taxonomy** — retryable, permanent, spend-related — shaped for whoever must act on it, and mapped to HTTP in one place by kind rather than by class, so a new failure type arrives already handled.
- **Embeddings (T22) are a sibling service, not a method on the completion one** — no system/user split, no structured-output retry, so they don't share `LlmService.run()`'s shape. They reuse its spend guards and usage logging into the same table, through OpenAI (Anthropic has no embeddings API), behind the same one-file-per-SDK rule.
- **Every real provider is backed by its fake by default under a test run, not only where a spec file thinks to override it.** Found the hard way: every spec file boots the full app, and a background-job handler registered by one domain module (T21's tracker, T22's retrieval) is reachable from *any* spec file's own instance of it, since they all share one local Postgres and its pg-boss queues. A spec file with no reason to care about retrieval was a genuine, reachable competing consumer for a job a different spec file enqueued, and its own un-overridden provider used a real (here: invalid) API key from `.env` — briefly, until this was made structurally unreachable rather than just usually avoided.

Inference is not EU-resident. Verified rather than assumed: the first-party API offers no EU routing value on any model, and the provider surface that does would be a second implementation behind the same interface — which is what the abstraction is for. For a single operator processing their own data this is a documentation gap; it would not be for anyone else.

## Vacancy intake and scoring

A posting is pasted as text. Nothing is fetched and no link is followed — a `source_url` is kept as a note. Storing the text is free and parsing it is a separate, rate-limited call, because parsing is the step that spends money while pasting is the step someone does twenty times in an evening.

**Nothing found is hidden by deleting it.** The line intake draws is between a *blocker*, which is about possibility — a market outside the supported scope, a requirement that cannot be met — and a *minus*, which is about preference: pay, format, stack. A blocked vacancy is written as a row with its reason readable, and is only absent from the default list; a flag returns it.

The reason is not caution for its own sake. A profile is an approximation of preferences the person has **not finished discovering** — a domain they did not know interested them will outweigh both the band and the location, and it is not in the profile because it could not have been. Filtering hard against the profile filters against yesterday's version of the person. The classification is itself fallible, which is the other half of why it has to stay readable.

The consequence at intake: a posting outside the supported European markets is stored and marked rather than refused, so NFR15 becomes visible rather than silent.

**Deduplication is exact-match only** — a normalised hash of the pasted text, deliberately not unique, so a repeat is routed to the row that already holds it instead of being refused. Recognising the same posting copied from another board, or the same role behind an agency and its client, needs a derived identity key whose accuracy is unmeasured and a volume of postings that manual pasting does not produce. A wrong link is invisible exactly where it does damage, so both wait for the volume that would let them be measured.

**Whether a posting comes through an intermediary is extracted as a hypothesis carrying its evidence**, never as a verdict. Being submitted through an agency commonly forecloses applying to the employer directly, so it is worth settling before applying rather than discovering afterwards — which is also why a confident wrong answer here is expensive. The undecided answer is a first-class value, and the quoted words any answer rests on are stored beside it.

**Scoring produces two analyses under opposite rules, not one.** `presentable` is what genuinely attracted the candidate and what she can offer — compensation, work mode, stack match and benefits are excluded, because those are reasons to accept an offer, not reasons that would persuade an employer. `tradeoff` is the private, two-sided view for her own decision — the same four fields are required there, since leaving them out would make the decision blind. One model call produces both, kept structurally separate; a real vacancy that leaks an excluded field into `presentable` is the failure the primary test checks for.

Scoring re-surfaces the same market-scope blocker computed at intake rather than inventing a second blocker vocabulary — nothing yet needs a blocker that only scoring, not intake, could know about.

Each score is inserted as a new row rather than overwriting the last one — a snapshot of that model, that prompt version, against the profile and resume as they stood at that moment. It is not recomputed when the profile or resume changes later, which means a stale score can sit next to a profile it no longer reflects. *Revisit when re-scoring on profile change is worth the calls it would spend — most likely once the profile starts changing often enough for staleness to be the more visible problem.*

## Execution model

Most of what's built is a synchronous request handler. The rule for what should not be is written down: work that can fail partway and needs retries, is expensive to redo, or has to happen later belongs on a queue.

**pg-boss (T20)** is that queue — Postgres-backed, its own `pgboss` schema in the same database, no separate service. It runs in-process, inside the same app that serves HTTP: this repo deploys one image to one Container App, and a separate worker process would be new CI, new deploy wiring and new secret access for a project with no queue depth yet. The units of work that would move take identifiers rather than content (NFR7), so a handler becomes a job by being wrapped rather than rewritten, and a queued payload can never outlive the row it refers to.

The one real cost of running in-process, worth stating rather than discovering later: under scale-to-zero, pg-boss's poller and delayed-job wake-ups only run while the container is warm — a delayed job due while nobody's hitting the app waits for the next request. Nothing depends on precise timing today; revisit if something ever does.

`pgboss.create_queue()` does real DDL (a `CREATE TABLE`/`ATTACH PARTITION` per queue) and runs as its caller, and `app_user` has no CREATE rights — so every queue name is provisioned once, by migration, through the admin connection, exactly like a table; the runtime app only ever calls `send`/`work`/`schedule` against a queue that already exists. `app_user`'s default PUBLIC execute grant on `create_queue`/`delete_queue` is explicitly revoked, so the missing invariant is "cannot call it" rather than "calling it happens to fail" — the difference matters the day something else grants `CREATE` on the schema for an unrelated reason. `parseVacancy` and `scoreVacancy` stay synchronous forever for their existing callers, someone waiting on the answer — they are not job handlers, and pg-boss's first real consumer is the application tracker, described below.

Cron delivery itself is not wired up: pg-boss's own cron engine is disabled (it would otherwise call `create_queue` on its own internal relay queue at every boot, the exact runtime DDL call the paragraph above rules out, for a queue this repo never provisioned a partition for). `schedule()` records a row; nothing currently reads it. Revisit together, once something needs real cron: provision that internal queue by migration, then turn the engine back on.

For anything long-lived the intended shape is a state machine on domain tables — a status column plus an append-only event timeline — with jobs as its timers, rather than a long-running process object.

**The application tracker (T21)** is the first thing to actually be that shape, and pg-boss's first real consumer: `applications.status` plus an append-only `application_events` timeline, with a delayed job as the one timer — a follow-up reminder enqueued when an application reaches `applied`, firing 14 days later if nothing else happened first. A later status change does not cancel that job (there is no cancel-by-key mechanism), so a stale reminder can fire after the application has already moved on; its handler checks the current status and writes nothing if it no longer applies. Accepted as-is — the alternative is tracking a job id per application solely to cancel it, for a reminder that is otherwise harmless to skip.

## Hosting

A container on a managed platform with scale-to-zero, a managed Postgres, and object storage for files. Secrets come from a managed vault reached by workload identity, never from environment configuration, through exactly one code path with a swappable backend.

Concretely that is Azure Container Apps, Azure Database for PostgreSQL and Blob Storage. Little in the code is coupled to those: the image is ordinary, and the equivalent services elsewhere are a configuration change plus one adapter rather than a rewrite.

A migration to another cloud was considered and is **cancelled**. Where an argument in this document once rested on portability, it now rests on its own merits or has been dropped.

## CI/CD

CI runs on every push: install, typecheck, lint, build, and tests against a real Postgres and a real storage emulator. A secret scan runs over the whole history rather than the tip, because a secret committed and later removed is still there and still readable.

**Deploying is a separate manual action**, never a consequence of a push or a merge. It authenticates through OIDC federation with no stored cloud credential, refuses any commit whose CI run for that exact SHA is not green — a missing run counting as not green — and probes readiness afterwards rather than trusting its own exit code.

That refusal has one deliberate way past it: an input, defaulting to off, that proceeds despite a red CI and prints a warning into the run. A gate with no escape hatch gets deleted the first time someone must ship past a known, unrelated failure, and then nothing is enforced at all.

Resource names come from repository variables with no defaults in the workflow, so the pipeline describes a shape rather than naming an installation.

### Branching

Work happens on a branch taken from `develop`, and `develop` is where it integrates. The release branch is never committed to directly and only ever advances by merge.

That is enforced rather than agreed: a hook refuses commit, merge, rebase and `reset --hard` while the working tree is on a protected branch. It became a hook after the rule was broken twice while it depended on someone remembering it.

**The release branch takes whole updates, never fragments.** Something moves there when it is finished and every part of it has been exercised — not when it merely passes CI. Half a feature can be perfectly green and still has no business there, because what that branch is for is naming a state someone could stand on. `develop` sitting several commits ahead is the normal state, and draining it for tidiness is the mistake this rule exists to prevent.

When work on a project stops, `develop` merges into the release branch, so the default branch shows the final state rather than whatever it happened to show.

Branch names carry what the branch is for: a feature or an epic names itself, anything else names its kind — `docs/`, `ci/`, `chore/`, `fix/`.

### Tests

What counts as mandatory, so that "tests are required" means something specific:

- **Anything touching user-owned data proves isolation against a real database.** Not a mock: the isolation is enforced by row-level security, and a mock cannot be wrong in the way the real thing can. Two users are seeded, and the assertion is that a plain query returns one user's rows.
- **Anything crossing a boundary is exercised through that boundary.** An upload endpoint is driven over HTTP with a real multipart body rather than by calling the handler, because routing, the multipart parser and the binary response are where an upload goes wrong, and none of them exist when a function is called directly.
- **Every defect found by hand gets a regression test before the fix is committed.** Several defects here lived on failure paths a green suite never touched.
- **Prompt templates carry a fingerprint test**, so the text cannot change without the version moving.
- **No test spends money.** The provider is always a fake.

`npm test` runs them; they need the local stand up and migrations applied.

### Review

One developer, so there is no rotation to name. What stands in for one: an automated pass over the change before it is proposed, on separate axes — conventions, architecture, requirements conformance — rather than one merged pass, because merged into a single pass the requirements check always loses. A human approves the diff itself, not a description of it. What blocks a merge is a failing gate, a convention from `CLAUDE.md`, or an unrecorded deviation from a decision here. Everything else is a comment.

## Retrieval and chat

The rules below were settled in advance rather than invented under pressure, because chat is the first feature that would produce a vector and every one of these choices is expensive to reverse once vectors exist. **Retrieval infrastructure (T22) applies them**; chat itself — a conversational endpoint, generation over retrieved chunks — stays on the TODO list.

- **Storage is a vector column in the same Postgres**, not a second vector service — `pgvector`, enabled by migration, `vector(1536)` columns, HNSW indexes.
- **The corpus is the application's own rows.** Built so far: extracted resumes and parsed vacancies. Scores, applications and their events are deliberately not chunked yet — same "one focused slice" precedent as T20/T21, not a scope cut. Each source type gets its own chunk table with a real `ON DELETE CASCADE` FK to its specific source row — no polymorphic `chunks` table — which is what makes ownership and erasure need no separate treatment (ownership deletes the chunk without any application code knowing it happened). Staleness is a content hash stored beside each chunk: a reindex skips a source row whose hash hasn't changed, so nothing is ever re-embedded, and re-paid for, without cause. Nothing outside the database is a source, and no ingestion path reads a filesystem.
- **Ingestion is job-shaped and manually triggered** (`POST /me/retrieval/reindex`) — chunking and embedding are slow and worth retrying, and every LLM/embedding-calling action in this app runs at the caller's own request rather than as a side effect of an unrelated write. Query-time retrieval (`POST /me/retrieval/search`) stays synchronous, because someone is waiting for the answer.
- **One embedding model across the system** (`text-embedding-3-small`, via OpenAI), with the model version stored beside every vector, so a model change becomes an explicit "this vector is stale" flag rather than a silent decay in search quality. HNSW rather than IVFFlat: the latter needs training on data and behaves poorly on small, growing tables.
- **A long vacancy posting is truncated, not really chunked, for now** — one row still renders to one chunk, capped well under the embedding model's input limit. The schema's `chunkIndex` column already allows real sliding-window splitting later without a migration; nothing needed it yet at this corpus's size.

## Deliberately deferred

Decisions not made, as distinct from the decisions made and recorded above:

- **Sessions cannot be revoked before they expire.** Stateless tokens were chosen so there is no session state to lose across restarts. The guard verifies on every request that the account still exists, so a deleted account stops working immediately; signing out of an existing account elsewhere is what is missing.
- **Rate-limit counters are in-process.** With one replica that is the whole picture; past one, each replica keeps its own and the effective limit multiplies by the replica count.
- **CORS is undecided** — there is no frontend to scope it against.
- **A second identity provider**, and linking one to an existing account. The identity model is provider-agnostic already. Linking must be an authenticated action rather than an inference at sign-in, which is why the endpoint does not exist rather than existing unguarded.
- **Uploaded files are not scanned for malware**, and the accepted type is the one the client declares rather than what the leading bytes say — which refuses honest callers that omit it and constrains dishonest ones not at all.

## Requirement identifiers

The code and tests cite these in comments and test names. This is an index, not a second statement of the decisions: each entry says what the identifier names and which section above decides it. Only identifiers the code actually cites are listed.

| | Names | Decided in |
|---|---|---|
| **FR1** | sign-in through an external provider, no self-managed passwords | Data model, and `src/auth` |
| **FR4** | resume upload | Data model — the raw/structured split |
| **FR5** | export and deletion in one action | Personal data |
| **FR6** | vacancies pasted as text, parsed into structure | Vacancy intake and scoring |
| **FR7** | a parsed vacancy scored against a profile and resume | Vacancy intake and scoring |
| **FR21** | onboarding is step-addressable | cited by the code as the reason for a payload shape; the step itself was never built |
| **FR22** | an application is tracked through its lifecycle, with a follow-up reminder if it goes quiet | Execution model, `src/tracker` |
| **FR23** | the user's own resumes and vacancies are chunked, embedded, and searchable by similarity query | Retrieval and chat |
| **NFR1** | every model call is metered | The LLM layer |
| **NFR2** | spend capped per attempt, per conversation, per month | The LLM layer |
| **NFR3** | secrets from a managed store through one path | Hosting |
| **NFR4** | files reachable only through an authenticated endpoint | Personal data |
| **NFR5** | user-scoped connection with row-level security beneath it | Data model |
| **NFR6** | deletion and export from the first release | Personal data |
| **NFR7** | queued work carries identifiers, never content | Execution model |
| **NFR11** | one entry point for model calls | The LLM layer |
| **NFR15** | European markets only at launch, marked rather than silently dropped | Vacancy intake and scoring |
| **NFR16** | no recovery mechanism outlives a deletion request | Personal data |
| **NFR17** | one embedding model version stored beside every vector; a model change is an explicit stale flag, not silent decay | Retrieval and chat |
