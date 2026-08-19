---
name: code-review
description: Reviews uncommitted (or recently written) code in career-consulting-ai before it is committed — one entry point that fans out into fresh-context reviewers, refutes each finding before reporting it, and consolidates. Use this at the end of a plan→implement→test cycle, whenever the user asks for a code review, and always before proposing a commit. Fixes only what the user approves. Not an architecture review (see arch-review) and not a spec-conformance review (see ba-review).
---

# Code review for career-consulting-ai

One command, four stages: **gather → fan out → verify → consolidate.**

The goal is to catch what tests don't: conventions that quietly rot, security boundaries that got softened, and code that works today but will mislead whoever reads it in three months (usually the same person who wrote it).

**A green test suite is not a passing review.** Say so plainly if the tests pass and the code still has a problem.

---

## Stage 0 — where this runs

**Every reviewer gets a fresh context.** Do not review inline in the session that wrote the code: there the review inherits every claim made while implementing, including the ones that were reasoned rather than checked. An unverified premise is indistinguishable from a verified one once it is in the transcript, so the review ends up standing on the story instead of testing it. Compaction makes it worse — summarising drops the "unverified" qualifier and promotes the claim to a fact.

In practice: dispatch subagents (each gets its own context window), or run in a new session. Never both write and review in one context.

A fresh context removes inherited premises; it does **not** remove the model's own blind spots — those are shared across contexts. Where the runtime allows picking a model per subagent, run the **verify** stage on a different model than the finders: two models fail differently, so their agreement carries information. This review is additive and never a substitute for the user reading the diff.

---

## Stage 1 — gather the input pack (once)

Assemble once, hand the *same* pack to every reviewer, so findings are comparable and nobody re-derives it four times:

| Include | Withhold |
|---|---|
| The diff: `git status` + `git diff` staged and unstaged, **plus untracked files** — new files are the easiest to forget | The implementation transcript and its reasoning |
| The stated intent: what the user asked for, and the constraints they gave | Approaches tried and abandoned mid-session |
| The conventions: `.claude/skills/implement-plan/SKILL.md`, `docs/TRADEOFFS.md` (did this trip a revisit trigger, or create an unrecorded shortcut?) | The implementer's own summary of what it built |

Withholding the reasoning is the point. **Including the intent is equally the point:** without it a fresh reviewer produces confident false findings — "why not do X?" — about alternatives that were ruled out for reasons it cannot see.

### Size the review to the diff

| Diff | Reviewers |
|---|---|
| A few hunks in one or two files | **One** fresh subagent, all lenses, no verify stage — the fan-out costs more than it finds |
| A normal change set | The four lenses below in parallel, plus verify |
| Touches migrations, auth/identity, LLM spend, or `src/db`/`src/llm` shared paths | All four lenses **and** verify, even if the diff is small |

---

## Stage 2 — fan out (one message, in parallel)

Dispatch all lenses **in a single message** so they run concurrently. Each gets the input pack, its brief, and the reporting contract from Stage 4.

**Lens A — correctness and seams.** Does the code do what the plan says and what its own comments claim? Concentrate on the seams: function bodies are usually right; call sites, error paths and edge cases are where it breaks. On failure, can the caller tell failure from success — silent `catch` blocks and swallowed errors are findings. Boundary conditions the tests didn't cover: empty input, a missing optional field, a second concurrent caller. **Any claim about "all callers" gets counted, not assumed.**

**Lens B — test integrity.** Do the new tests exercise the new behaviour, or assert on a mock's return value? Is the *interesting* case covered or only the happy path? **Would each new test fail without the fix?** If nobody checked, say so — a test that passes both ways is decoration, and a large green suite is the easiest place there is to hide a change nothing exercises. Anything found by hand during this cycle must have a regression test. RLS-touching tests must run through `createTestDb()` + `withUserContext()`, not the admin connection — a test that reads user rows as superuser proves nothing about the security layer.

**Lens C — load-bearing conventions.** Violations here are real defects, not style opinions:

- **Secrets only via `SecretsService`** — never `process.env` for a secret (non-secret config via env is fine). Ops-time scripts outside the app are the documented exception, not a precedent.
- **Schema changes only as a new migration** — never edit an applied one; locally-applied migrations are tracked by hash. The Drizzle schema and the migration must agree: a hand-written index missing from `schema.ts` is drift, and the next `db:generate` will try to create it again.
- **User-owned data through a user-scoped connection** (`withUserContext`), never the admin/migration connection. Reading user rows as a superuser bypasses RLS and looks fine in tests — this was a real bug, not a hypothetical.
- **LLM calls only through `LlmService`** — no provider SDK imports outside `src/llm/providers/`, no free-form instructions (templates only), no caller-invented `promptVersion`.
- **Trusted vs untrusted text** — anything a person or an external source supplied goes through the `untrusted`/data delimiters, never into the instruction half of a prompt. Model output is untrusted too.
- **Job payloads carry entity IDs, never content** (GDPR erasure), and handlers are idempotent (at-least-once delivery).
- **Docs in English**; no references to paths outside the repo; no financial or business content in repo docs.

**Lens D — security and data.** Is a new endpoint behind the auth guard, and does it scope by the session user rather than a client-supplied id? Anything touching identity, sessions, or account linking gets extra scrutiny — the T42 rules exist because the alternatives are account-takeover paths. Does new PII reach a log, an error message, an LLM prompt, or a queue payload?

*(Readability folds into Lens A: comments explain *why* not *what*; names match the vocabulary in the schema; dead code, leftover scaffolding and ownerless `TODO`s are findings.)*

---

## Stage 3 — verify before reporting

**A finding is a claim, and a wrong finding spends the user's time** — which is the currency this review exists to save. Every candidate goes through one refutation pass:

> Try to refute this finding: «finding». You have the same diff and intent. Default to *refuted* if you cannot show the problem is real. State which of `[OBSERVED]` / `[READ: path:line]` / `[INFERRED]` your conclusion rests on.

Drop what gets refuted; keep what survives, carrying the tier its evidence earned. Run these in parallel, on a different model where possible. This stage is also what stops lens overlap becoming noise: two lenses reporting one issue collapse into a single finding with the stronger evidence.

---

## Stage 4 — consolidate and report

Dedupe across lenses, then rank. Be concrete: file, line, what's wrong, why it matters, what the fix would be.

- **Must fix before commit** — correctness bugs, security issues, convention violations with real consequences.
- **Should fix** — costs time later, breaks nothing now.
- **Optional / noted** — keep short. Twenty nitpicks bury the finding that mattered.

**Each finding states its evidence tier:** `[OBSERVED: cmd → result]`, `[READ: path:line]`, `[INFERRED]`. Inferred findings are legitimate — *"this looks like it swallows the error, I didn't run it"* is honest and useful — but must be labelled, because the user triages by confidence.

**Negative claims need their searches shown.** "No PII reaches the logs" and "nothing else calls this" are claims about absence: cite what you searched, or downgrade to *"I found none, searching for X and Y."*

Don't manufacture findings to look thorough — an invented finding costs real time to evaluate.

### When nothing survives: report coverage, not a pass

An empty review is a **null result**, not assurance. Report in three lines:

- what was examined — which lenses ran, which files and paths, which risks;
- what was deliberately **not** examined, and why (outside the diff, needs a running stand, needs domain knowledge nobody had);
- where an adversarial reviewer should start.

The reason is measured, not philosophical: consecutive "the diff is clean" verdicts followed by human change requests are a known pattern, and they are indistinguishable from a broken review until coverage is written down. Written coverage is what makes a later miss diagnosable — **not examined**, or **examined and missed**? Those have different fixes.

---

## After the review

Fix only what the user approves, then re-run the gates (`npm run typecheck`, `npm run lint`, `npm test`) before proposing the commit. **Never commit as part of this skill** — commits happen after the user has looked at the diff, always.

## Measuring whether this review is any good

The ground truth is the user's own review. Track two numbers over time:

- **Misses** — what the user raised that this review did not. That is what recall means for a review asset.
- **False findings** — what was reported here and dismissed. A rising count means Stage 3 is too permissive, not that the review got thorough.
