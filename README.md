# career-consulting-ai

A career-consulting backend: positioning and the job-search cycle — sourcing,
scoring, tailored documents, interview prep, application tracking.

TypeScript/NestJS modular monolith, Postgres with pgvector, one versioned LLM
layer, containerized and deployed on Azure Container Apps.

## If you're looking for the parts worth reading

- **`src/llm`** — the only place a provider SDK is imported. Prompts are prose in
  git behind a versioned registry; a fingerprint test fails if the text changes
  without a version bump; trusted and untrusted input are separated structurally
  rather than by convention; spend is bounded per attempt, per conversation and
  per month. Rationale in [ARCHITECTURE.md](docs/ARCHITECTURE.md).
- **`src/resumes`, `src/storage`** — upload to blob storage kept apart from the
  extracted structure, so the raw file can be dropped without losing what the
  system reasons over.
- **`drizzle/`** — row-level security forced on every table, and the
  expand/contract migration rule in [ARCHITECTURE.md](docs/ARCHITECTURE.md),
  which exists because reversing a migration that dropped a column recreates it
  empty.
- **`src/auth`** — identity by `(provider, external_id)` only, never by email;
  admission by an allow-list that fails closed.
- **`.github/workflows/deploy.yml`** — deploying is a manual act, gated on CI's
  verdict for that exact commit, and it checks the revision is actually serving
  before reporting success.
- **[TRADEOFFS.md](docs/TRADEOFFS.md)** — what was knowingly left unhardened, and
  why that was the right call at this scale.

## Docs

Two, on purpose. [ARCHITECTURE.md](docs/ARCHITECTURE.md) — the decisions, the
data-model rules, and the requirements the code cites by number.
[TRADEOFFS.md](docs/TRADEOFFS.md) — what was knowingly left unhardened, and why
that was the right call at this scale.

## Running it locally

```
docker compose up -d      # Postgres + Azurite
cp .env.example .env      # then fill in the real values
npm ci
npm run db:migrate
npm run start:local
```

Tests need that same local Postgres: `npm test`. CI enforces `typecheck`, `lint`,
`build`, `test`.
