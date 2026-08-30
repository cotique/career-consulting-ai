# Working in this repository

Conventions that are load-bearing here. Breaking one is a defect, not a style
disagreement, so each carries the short version of why.

`docs/ARCHITECTURE.md` is the decision record — what was chosen, what was
rejected, what got reversed and by what. This file is the working set: the same
rules stated as instructions, in a sentence each. When they disagree, the
decision record wins; when you need the argument rather than the rule, it is
there.

## The rules that matter most

**Every model call goes through `src/llm`; no provider SDK is imported anywhere
else.** Routing, spend limits, metering and the untrusted-text convention all
sit behind that door. Going round it loses every one of them silently.

**Prompts are prose files behind a versioned registry**, never string literals
at a call site. Name a template and let the registry supply the version — the
fingerprint test exists to stop text and version parting company.

**Text from outside the system is untrusted**, and so is model output coming
back. One path renders it, inside delimiters. Never hand-assemble a prompt from
instructions plus untrusted content; a caller that *can* eventually will.

**User-owned data is read through a user-scoped connection.** The database
enforcement only engages when the request context is set, so opening a
connection any other way silently removes it.

**Migrations are expand/contract and never reversible.** Add in one migration,
switch code in the next release, drop later. The applied schema must keep
working for the code still running — that, and not a down script, is what makes
a deploy survivable.

**Bookkeeping does not share the caller's transaction.** Usage rows go on their
own connection, or a failed call erases the record of what it spent — and the
spend cap is computed from those records.

## Tests

`docs/ARCHITECTURE.md` defines what counts as mandatory. In practice: prove
isolation against a real database, drive boundaries through the boundary, add a
regression test for anything found by hand, and never let a test reach a real
provider.

Run them with `npm test`, with the local stand up and migrations applied.

## Before proposing a commit

`npm run typecheck`, `npm run lint`, `npm test`. All three, every time. CI runs
more than that — a build and a secret scan over the history — so a green local
run is necessary rather than sufficient.

A commit is proposed for review, never made unilaterally. Work happens on a
branch off `develop`; the release branch is never committed to directly.

## Two habits worth keeping

**After writing an error path, ask what else produces that message.** If the
answer is "a different problem with the opposite fix", split it. Two failures
wearing one face have cost more time here than any single bug.

**Decide the failure direction of each control explicitly.** Admission fails
closed; telemetry fails open; erasure fails toward a broken read rather than a
surviving file. The answer is not uniform, and the default is wrong about half
the time.
