# career-consulting-ai — architecture decisions

What was decided and why, including the decisions that were reversed and what reversed them. Column-level detail is deliberately not here: `src/db/schema.ts` and the migrations under `drizzle/` are the source of truth for shape, and a second description of it would drift.

The project was stopped at the end of its first iteration. This document says what exists and marks what does not, because a document that describes intentions in the present tense is how a reader ends up looking for code that was never written.

## What is built, and what is not

**Built:** sign-in through Google, an onboarding profile including a free-text step parsed by a model, resume upload with structured extraction, account export and deletion, and the infrastructure underneath — the LLM layer, per-request database isolation, rate limiting, telemetry and the deployment pipeline.

**Not built:** vacancy intake, scoring, and the application tracker. Their tables exist and their modules are empty. Document tailoring was dropped from scope entirely.

The tables anticipating unbuilt features were kept rather than removed: dropping them would be a migration whose only benefit is tidiness, and the schema records the shape the design assumed.

## Data model

The rules that shaped the schema, as opposed to its contents:

- **Every user-owned row carries `user_id` directly**, including child tables that could reach it through a join. Row-level security policies that join do not compose and degrade as the graph deepens, so the column is denormalised on purpose.
- **Row-level security is forced on every table**, keyed off `app.current_user_id` set per request inside a transaction. It is the layer that survives a forgotten `WHERE`, and it applies only if the application connects as a role that cannot bypass it — a database-level property, not a code convention.
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

Inference is not EU-resident. Verified rather than assumed: the first-party API offers no EU routing value on any model, and the provider surface that does would be a second implementation behind the same interface — which is what the abstraction is for. For a single operator processing their own data this is a documentation gap; it would not be for anyone else.

## Execution model

Everything built is a synchronous request handler. The rule for what should not be is written down: work that can fail partway and needs retries, is expensive to redo, or has to happen later belongs on a queue.

A queue was chosen for that work — Postgres-backed, in the same database, with retries, delayed jobs and cron — and **it is not installed**. Nothing in the repository depends on it. The choice is recorded because the code was shaped around it: the units of work that would move take identifiers rather than content, so a handler becomes a job by being wrapped rather than rewritten, and a queued payload can never outlive the row it refers to.

For anything long-lived the intended shape is a state machine on domain tables — a status column plus an append-only event timeline — with jobs as its timers, rather than a long-running process object.

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

## Retrieval and chat — decided, not built

The first feature that would produce a vector, and the reason the retrieval rules below were settled in advance rather than invented under pressure.

- **Storage** would be a vector column in the same Postgres, not a second vector service.
- **The corpus is the application's own rows** — extracted resumes, parsed vacancies, scores, applications and their events. Chunks derive from those, which means ownership and erasure need no separate treatment (a chunk descends from a row that already cascades) and staleness has a definition rather than a heuristic (a chunk is stale when its source row changed). Nothing outside the database is a source, and no ingestion path reads a filesystem.
- **Ingestion is job-shaped** — chunking and embedding are slow and worth retrying — while query-time retrieval and generation stay synchronous, because someone is waiting for the answer.
- **One embedding model across the system**, with the model version stored beside every vector, so a model change becomes an explicit "this vector is stale" flag rather than a silent decay in search quality. HNSW rather than IVFFlat: the latter needs training on data and behaves poorly on small, growing tables.

None of this exists. The database image can provide the extension, but no migration enables it and no vector column is defined.

## Deliberately deferred

Decisions not made, as distinct from the decisions made and recorded above:

- **Sessions cannot be revoked before they expire.** Stateless tokens were chosen so there is no session state to lose across restarts. The guard verifies on every request that the account still exists, so a deleted account stops working immediately; signing out of an existing account elsewhere is what is missing.
- **Rate-limit counters are in-process.** With one replica that is the whole picture; past one, each replica keeps its own and the effective limit multiplies by the replica count.
- **CORS is undecided** — there is no frontend to scope it against.
- **A second identity provider**, and linking one to an existing account. The identity model is provider-agnostic already. Linking must be an authenticated action rather than an inference at sign-in, which is why the endpoint does not exist rather than existing unguarded.
- **Uploaded files are not scanned for malware**, and the accepted type is the one the client declares rather than what the leading bytes say — which refuses honest callers that omit it and constrains dishonest ones not at all.

## Requirement identifiers

The code and tests cite these in comments and test names; this is where they resolve. Only the ones actually cited are listed.

- **FR1** — sign-in through an external identity provider, no self-managed passwords.
- **FR4** — resume upload, with the raw file and its extracted structure stored separately.
- **FR5** — the account owner can export or delete everything in one action.
- **FR21** — onboarding is step-addressable, so a later positioning step could be added without restructuring the payload. Cited by the code as the reason for a shape; the step itself was never built.
- **NFR1** — every model call is metered: tokens, model, task, cost estimate, and the prompt version that produced it.
- **NFR2** — spend is capped per attempt, per conversation and per user per month, and the caps refuse rather than warn.
- **NFR3** — secrets come from a managed store through one code path.
- **NFR4** — files are reachable only through an authenticated endpoint.
- **NFR5** — user-owned data is read through a user-scoped connection, with row-level security enforced beneath it.
- **NFR6** — deletion and export exist from the first release rather than as a retrofit.
- **NFR11** — one entry point for model calls; no provider SDK imported anywhere else.
- **NFR16** — no recovery mechanism outlives a deletion request.
