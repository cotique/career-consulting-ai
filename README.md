# career-consulting-ai

A backend for the job-search cycle, built as a study of how to make an
LLM-backed service that can be trusted with someone's own data: one entry point
for every model call, prompts as versioned artifacts, per-request database
isolation, and spend that stops rather than being reported afterwards.

TypeScript, NestJS, Postgres, containerized and deployed to Azure Container
Apps through a manually triggered pipeline.

## What is built

Sign-in through Google, an onboarding profile with a free-text step the model
parses, resume upload with structured extraction, account export and deletion,
and the layer all of that runs on.

Everything else the schema anticipates — vacancy intake, scoring, the
application tracker — exists as tables and empty modules and no more, and
document tailoring was dropped from scope entirely. The
project was stopped at that point deliberately; see the architecture document
for what was decided and what was left.

## The parts worth reading

- **`src/llm`** — the only place a provider SDK is imported. Prompts live as
  prose in git behind a versioned registry, and a fingerprint test fails if the
  text changes without the version moving, so an output comparison can never
  silently span two different prompts. Spend is checked before every attempt,
  including retries, and the usage row is written on the layer's own connection
  so that a caller's rollback cannot erase the record of money already spent.
- **`src/db`** — row-level security forced on every table, with the per-request
  user context set in one place. The application connects as a role that cannot
  bypass it.
- **`src/auth`** — identities matched on the provider's immutable subject and
  never on email; admission separate from authentication, defaulting to nobody.
- **`.github/workflows`** — CI on every push; deploying is a separate manual
  act, refused for any commit whose CI run is not green, and the whole history
  is scanned for secrets.

## Docs

- **[ARCHITECTURE.md](docs/ARCHITECTURE.md)** — the decisions and why they were
  made, including the ones that were reversed and what reversed them.
- **[CLAUDE.md](CLAUDE.md)** — the rules that follow from those decisions, for
  whoever writes code here.

## Running it locally

```
docker compose up -d      # Postgres + Azurite
cp .env.example .env      # then fill in the values it asks for
npm ci
npm run db:migrate
npm run start:local
```

Tests need that same local Postgres and Azurite: `npm test`. CI runs
`typecheck`, `lint`, `build` and `test`, plus a secret scan over the history.

Deploying needs cloud resources of your own; the workflow takes every name from
repository variables and has no defaults.
