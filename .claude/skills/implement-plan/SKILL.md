---
name: implement-plan
description: Writes code for career-consulting-ai from an already-approved plan (see plan-feature). Use this whenever the user asks to implement, build, or code up a task/feature that has a plan for this project, or says things like "implement this", "write the code for X", "build the Y workflow now". Follows this repo's established conventions — TypeScript/Node modular monolith, a single LLM abstraction layer, pg-boss job conventions — and does not introduce new architectural decisions beyond what docs/ already settled; if something isn't covered by the plan or the docs, stop and ask rather than guessing.
---

# Implement a plan for career-consulting-ai

Work from an approved plan (from `plan-feature`, or given directly by the user). Translate it into code that fits the existing codebase conventions — this is not the stage for making new architectural calls. If the plan is missing a decision you need (which LLM provider to call, how a specific edge case behaves), stop and ask instead of inventing an answer. `docs/ARCHITECTURE.md` deliberately deferred some decisions to implementation time — that doesn't mean whoever is implementing gets to decide them unilaterally for a project this consequential to the user's actual job search.

## Structural conventions

- **Modular monolith** — one module per domain (intake, scoring, tailoring, memory, tracker, self-audit, wellbeing) under `src/`. Put new code in the module the plan named; don't create a new top-level module without flagging it first.
- **Migrations are forward-compatible, never reversible** (see the data-model rules in `docs/ARCHITECTURE.md`): a migration must be safe to have applied while the *previous* code version is still running. Add first, switch the code in the release that follows, drop only in a later migration. A rename is add + backfill + later drop. Don't write "down" scripts and don't rely on one — reversing a migration that dropped a column recreates it empty, so the undo that looks like a safety net is the thing that loses the data.
- **LLM abstraction layer** — every LLM call goes through the single abstraction described in `docs/ARCHITECTURE.md`. Never import a provider SDK (Anthropic/OpenAI/Azure OpenAI) directly into business-logic code — that defeats the point of the abstraction: swappable providers/models per task, and centralized usage logging for the cost controls (NFR1/NFR2). Specifically:
  - **A new prompt means a new template**, not a string in a service. Prose goes in `src/llm/templates/text/<name>.md`, metadata in the module beside it, and the template is registered in `src/llm/templates/index.ts`. Callers name the template; they never pass instructions or a `promptVersion`.
  - **Editing an existing prompt means bumping its `version`** and updating the pinned fingerprint in `template-versions.spec.ts` — the test will tell you the new hash. Don't paste the hash without bumping the version; that defeats the check.
  - **Expecting JSON back means `completeStructured` with a zod schema**, not hand-parsing the text. Bounded retry and the typed schema failure come with it.
  - **Untrusted text goes in `untrusted`**, keyed by a label the template declares. Anything a person, a webpage, or a *model* produced is untrusted.
- **Background job conventions** (pg-boss, see `docs/ARCHITECTURE.md`) — all three are load-bearing, not style preferences:
  - **Payloads carry entity IDs, never content.** Queue rows would otherwise outlive a user's delete-cascade, which is the GDPR erasure hole that got Temporal removed. Handlers re-read what they need from domain tables.
  - **Workers are batch-style: wake → drain the queue → exit**, not long-running listeners — the deployment target is scale-to-zero with a scheduler waking the drain job.
  - **Handlers must be idempotent** — pg-boss is at-least-once; the same job can and will run twice.
- **No speculative abstractions** — build what the plan asks for, not a generalized version "in case" something else needs it later. This project is explicitly framed as a side project with no pressure to scale — don't let implementation quietly reintroduce that pressure.
- **Comments** — only where the *why* isn't obvious from the code itself (a workaround, a non-obvious constraint). Don't narrate what the code does.

## Repo conventions that exist in code (born in Epics 0–1 — don't relearn these the hard way)

- **Secrets** — runtime code reads secrets only through `SecretsService` (`src/config/secrets.service.ts`), never `process.env` directly. Ops-time scripts that run outside the app (like `src/db/migrate.ts`) are the documented exception, not a precedent.
- **Schema changes** — always a *new* migration via `npx drizzle-kit generate` (or `--custom` for raw SQL like RLS policies). Never edit an already-generated migration file: locally-applied migrations are tracked by hash, and editing one desyncs every database that already ran it.
- **Two database roles** — the app (and anything acting like the app, including tests of app behavior) connects as `app_user` via `DATABASE_URL`; that role is deliberately non-superuser so RLS actually applies (superusers bypass RLS even with `FORCE` — a real bug this project actually hit). Migrations use `MIGRATION_DATABASE_URL` (admin role). Wiring new code to the admin connection "because it's easier" silently disables the security layer.

## Execution style

Once a plan is approved, run the whole thing end to end — don't stop after each file or each task within the plan to check in. If a genuine clarifying question comes up (an ambiguity the plan didn't resolve, a choice that needs the user's input), ask it **before** acting on the assumption, not after already writing code that might need to be undone.

**Never commit without the user reviewing the changes first.** Implement, verify (typecheck/lint/build/test — see below and `test-implementation`), and report what's ready — but the commit itself waits for the user to look at the diff and say so. This is a standing rule for this repo, not a one-off.

## After writing code

Run typecheck, lint, and build before considering the work done (all three are set up — `npm run typecheck` / `lint` / `build`).

**Then run `code-review` over the change, before proposing a commit.** This is the last step of every plan→implement→test cycle, not an optional extra: tests prove the code does what you told it to, the review is what catches the convention that got bent and the boundary that got softened. Report its findings together with the implementation summary, so the user reviews the diff already knowing what's questionable in it.

If reality diverged from the approved plan while implementing (a bug forced a different approach, scope narrowed, an extra migration appeared), say so explicitly in the done report — the divergence is *discovered* here, so recording it is this stage's job. And if the implementation introduced a new deliberate shortcut (something known-not-right at scale), add it to `docs/TRADEOFFS.md` with a revisit trigger immediately — not at the end of the epic, when it's already been rationalized away.

## Reporting completion

The words **done, complete, clean, ready to push** are off limits unless a typecheck/lint/build and a test run appear in the same turn, with their results. A green suite proves the change did not break what was already covered — not that the new behaviour works (see `test-implementation` on the canary rule and coverage honesty).

Report in four parts: **Changed** / **Verified** (literally what you ran and what it printed) / **Not verified, and why** / **Yours next**. The third section is the point of the structure — an empty one is a claim in itself.

If you review your own diff, a zero-finding result is a **null result, not a pass**: say "self-review found nothing, which is weak evidence on a change like this", and name what an adversarial reviewer should look at.

## When the plan and the docs disagree, or the plan is silent

Don't silently pick one — say what you see and ask. The reason `plan-feature` and this skill are separate is so architectural decisions get made once, deliberately, with the user — not re-litigated implicitly during implementation.
