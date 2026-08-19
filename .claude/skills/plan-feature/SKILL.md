---
name: plan-feature
description: Produces an implementation plan for a task or feature in the career-consulting-ai repo, grounded in the project's own docs (docs/ARCHITECTURE.md, docs/TRADEOFFS.md).
---

# Plan a feature for career-consulting-ai

This repo's architecture was deliberately worked out through direct conversation before any code existed, and captured in `docs/`. Every plan you write should apply that already-agreed design to a specific piece of work — not re-decide the architecture per task. If a task doesn't fit cleanly into what the docs describe, say so explicitly in the plan as an open question, the same way the docs themselves flag deferred decisions — don't quietly invent a new architectural call to fill the gap.

## Read first

- `docs/ARCHITECTURE.md` — stack, hosting, execution model (pg-boss jobs vs. synchronous handlers), module boundaries
- `docs/ARCHITECTURE.md` again, for two things worth reading separately: the data-model rules (what any new table or column must obey) and the FR/NFR list at the end, so a task can cite the requirement it serves
- `src/db/schema.ts` and `drizzle/` — the actual tables, which are the source of truth for shape
- `docs/TRADEOFFS.md` — deliberate shortcuts with revisit triggers. Check both directions: does this task *trip* an existing revisit trigger (then the plan should include resolving it — e.g. the deploy job was deferred there and any deploy-touching plan must honor that), and does this task *create* a new deliberate shortcut (then the plan should say it gets recorded there).

## Decide: background job or synchronous handler?

`ARCHITECTURE.md`'s rule: if the work can fail partway through and need retries, is expensive to redo, or has to happen later (a timer, a schedule) — it's a **pg-boss job**. If it's a single fast request that needs to feel responsive in the moment (retrieval, chat) — it's a **plain synchronous handler**. State which one this task is, and why, in the plan.

For anything long-lived (a process spanning days or weeks, like the application lifecycle), the shape is a **state machine on domain tables** — status column plus an append-only event timeline — with jobs acting as its timers. Don't propose a long-running process object; that was the Temporal model, removed in the 2026-08-09 review for solo-ops burden and payload-retention (GDPR) reasons.

## Identify the module(s) touched

The backend is a modular monolith — domain modules exist for intake, scoring, tailoring, memory, tracker, self-audit, and wellbeing, plus the shared LLM abstraction layer. Name which module(s) the task lives in. If it spans several, say which one owns the core logic and which are just called from it.

## Flag database changes

Check the existing tables in `src/db/schema.ts` first — most work extends an existing table rather than needing a new one. If a new table or column is genuinely needed, follow the conventions already established there:
- `user_id` on every user-owned row, with `ON DELETE CASCADE`
- a raw/structured split for anything that's a file or PII
- `prompt_version` alongside anything LLM-generated that self-audit might need to compare over time
- `embedding_model_version` alongside any vector column

## Map to FR/NFR

Check the requirement list at the end of `docs/ARCHITECTURE.md`. If the task implements or touches a requirement, cite its ID (e.g. "implements FR8, respects NFR11"). If nothing covers it, say so plainly — that's a useful signal the spec may need updating, not something to paper over.

## Output

Present the plan through plan mode so the user approves it before any code gets written. Cover: what's being built, which module(s), background job vs. synchronous handler and why, any DB changes with rationale, and the FR/NFR mapping. Be concrete — name real file paths, function names, and table names where you can, not just prose description.

Every plan must end with a **Verification** section: how it will be proven working, concretely — which tests at which layer (see `test-implementation`), and any manual check left for the user. "Tests pass" isn't a verification plan; "an integration test that seeds two users and proves a plain SELECT only returns one's rows" is. If part of the work can't be verified yet (missing infrastructure, deferred dependency), the plan says so explicitly instead of leaving it to be discovered during testing.

## Open with a task contract, and label your evidence

Three lines before the detail, so the boundaries are agreed before the design is argued:

- **Will do** — the scoped outcome.
- **Will verify by** — the check that will prove it.
- **Out of scope** — what this task deliberately does not touch. Naming this is what keeps a plan from quietly growing during implementation.

Tag every causal or state claim the plan rests on with where it came from: `[OBSERVED: cmd → result]` (you ran it, read the log, queried the DB), `[READ: path:line]` (you read the source), `[INFERRED]` (you reasoned from names, types, or convention). Reading code and observing behaviour feel identical once a line number is attached — that is exactly why the distinction has to be written down. An `[INFERRED]` claim may never be the load-bearing one, and anything about a provider, a runtime, or remote state needs `[OBSERVED]` or an explicit "I have no verified source for this".

For each causal claim, write the **falsifier**: one line saying *"this is wrong if ___"*, and check it before presenting the plan. A hypothesis with no falsifier drifts toward whatever the user last objected to instead of toward evidence.

## Granularity: one task, or a whole epic?

Default to one plan per task. But when several pieces of work are tightly coupled and sequential (scaffolding, where each step sets up the ground the next one stands on), a single larger plan is better than several thin ones that would just repeat each other's context. Use judgment: if splitting the plan by task would mean re-explaining the same setup in each one, write one plan for the epic instead.

Within an epic-level (or any) plan, mark which steps need a human to actually do something outside of code — e.g. adding a secret in the Azure portal, clicking through a cloud console, approving something in a UI. Flag these as **manual** steps in the plan so it's clear upfront which parts `implement-plan` can execute directly and which parts need to come back to the user mid-implementation.

## Where an approved plan goes

Plans are not archived in this repository — it deliberately carries two documents and the code, nothing more. A plan lives in the conversation that approved it, and what survives is whatever it *changed*:

- A decision that shapes the system (a job-versus-synchronous call, a schema rule, a framework choice) belongs in `docs/ARCHITECTURE.md`, in the section it affects.
- A deliberate shortcut belongs in `docs/TRADEOFFS.md` with its revisit trigger, written when it is taken rather than at the end, before it has been rationalised away.
- Everything else — the sequencing, the alternatives weighed and dropped — does not need to outlive the work.

If reality diverges during implementation, say so in the done report rather than quietly letting the difference stand. That is the same honesty-calibration principle the product applies to its own output, applied to the build process.
