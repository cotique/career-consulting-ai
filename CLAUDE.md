# Working in this repository

Conventions that are load-bearing here. Breaking one is a defect, not a style
disagreement, so each says why.

`docs/ARCHITECTURE.md` holds the decisions and the reasoning; this file holds
the rules that follow from them. Where the two overlap, the document is the
source and this is the summary.

## The rules that matter most

**Every provider SDK import lives in `src/llm/providers`.** Nothing else calls a
model directly. Routing, spend limits, usage accounting and the untrusted-text
convention all live behind that one entry point, so a call made around it
silently escapes every one of them.

**Prompts are prose files behind a versioned registry**, never string literals
at a call site. A caller names a template; the version comes from the registry.
A fingerprint test fails if the text changes without a version bump, because
comparing outputs across an unlabelled prompt change produces a conclusion
about the world that is really a conclusion about the prompt.

**Text from outside the system is untrusted**, including model output fed back
in. It is rendered inside data delimiters by one path. A caller that can
concatenate instructions with untrusted content eventually will.

**User-owned data is read through a user-scoped connection.** Row-level
security is the layer that survives a forgotten `WHERE`, and it only applies
when the request context is set. The application must never connect as a role
that bypasses it.

**Migrations are expand/contract and never reversible.** Add in one migration,
switch code in the next release, drop later. Reversing a migration that dropped
a column recreates it empty, so the "undo" is the step that loses the data. The
property that protects a deploy is that the applied schema still works for the
code that is still running.

**Bookkeeping does not share the caller's transaction.** Usage rows are written
on their own connection: when they rode along with the caller, a failed call
rolled back the record of money already spent, and the spend cap is computed
from those rows.

## Tests

See `docs/ARCHITECTURE.md`, section "Tests", for what counts as mandatory. The
short version: anything touching user-owned data proves isolation against a
real database, anything crossing a boundary is exercised through that boundary,
every defect found by hand gets a regression test, and no test spends money.

Run them with `npm test`. They need the local stand up (`docker compose up -d`)
and migrations applied.

## Before proposing a commit

`npm run typecheck`, `npm run lint`, `npm test`. All three, every time. A commit
is proposed for review, never made unilaterally.

Work happens on a branch off `develop`; the release branch is never committed to
directly. See "Branching" in the architecture document for when it advances.

## Two habits worth keeping

**After writing an error path, ask what else produces that message.** If the
answer is "a different problem with the opposite fix", split it. Two failures
wearing one face have cost more time here than any single bug.

**Decide the failure direction of each control explicitly.** Admission fails
closed; telemetry fails open; erasure fails toward a broken read rather than a
surviving file. The answer is not uniform, and the default is wrong about half
the time.
