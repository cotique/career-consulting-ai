---
name: ba-review
description: Business-analyst review of career-consulting-ai — traces what is built against the FR/NFR list in docs/ARCHITECTURE.md, and hunts for contradictions in the described product logic (between documents, and inside a single document). Use when the user asks whether the implementation matches the spec, whether the requirements still hold after a set of changes, or to check the docs for internal inconsistencies before continuing. Reports findings; does not rewrite requirements without approval.
---

# BA review for career-consulting-ai

Two jobs, in this order: **traceability** (does what exists match what was specified, in both directions) and **coherence** (does the specification contradict itself, or the other documents, or reality).

Requirements drift silently. A decision taken in conversation lands in the code and in one document, and three other documents keep describing the old world — each of them individually plausible. This review is how that gets caught.

## Read first

`docs/ARCHITECTURE.md` is the reference — the FR/NFR list at the end of it, plus the decisions and data-model rules above them. Then `docs/TRADEOFFS.md` for the gaps that are deliberate, and the code itself for what is actually true.

There is no separate requirements document and no plan archive: if a claim in `docs/ARCHITECTURE.md` and the code disagree, that is a finding, and the code is the evidence.

## Part 1 — Traceability

Walk the FR/NFR list. For each requirement in current scope, place it in one of:

- **Implemented** — and name the evidence (module, endpoint, test). "Probably done" is not a status.
- **Partially implemented** — say precisely which half. This project has a habit of deliberately splitting requirements across epics (a mechanism now, its enforcement later); a documented split is fine, an undocumented one is a finding.
- **Not started** — and confirm a task owns it.
- **Deviated** — built differently from what the requirement says. Deviation is legitimate (FR3's "auto-detected" timezone can't work in an API-only MVP), but it must be *recorded* at the requirement, not just in someone's memory.
- **Orphaned** — behavior that exists in the code but no requirement asked for. Either the spec is missing a requirement or the scope grew quietly; both are worth naming.

Also check the reverse: a requirement claimed as built whose evidence you cannot find is a finding, and a fairly serious one.

## Part 2 — Contradictions

Look for these specifically:

- **Between documents.** The same behaviour described two ways in `docs/ARCHITECTURE.md`; a requirement listed there that nothing implements; a mechanism described in prose that the code replaced.
- **Inside one document.** A requirement that contradicts the scope section; a §7 still listing the machinery a revised §5 removed.
- **Against the data model.** "We never store X" while a column stores X; a deletion or export promise the schema cannot keep (cascades, blobs, queue payloads).
- **Against a decided tradeoff.** A requirement that assumes something `TRADEOFFS.md` says is deliberately absent.
- **Inside the product logic itself.** Two features whose rules can both trigger and disagree; a promise to the user the system cannot keep in some ordinary case (a notification time in a timezone that was never collected; an honesty claim about output the pipeline can't actually verify).
- **Untestable requirements.** A requirement with no observable acceptance condition can't be traced in a future review either — flag it now.

## What is *not* a finding

- A deliberate, recorded gap with a revisit trigger.
- A post-MVP requirement not yet built (check §9 scope before flagging).
- A frozen plan that no longer matches reality, where the change is recorded elsewhere.
- Wording you would have phrased differently.

## Reporting

One table for traceability (requirement · status · evidence · note) and one for contradictions (what · where · why it matters · proposed resolution). Quote the conflicting lines directly — a contradiction stated in the abstract is hard to act on and easy to argue with.

For each contradiction, propose *which side should change*, and say why. Most of the time the code is right and a document is stale; when it's the other way round, that is the more important finding and should be called out as such.

### An empty result is a null result

A review that reports nothing is weak evidence, not assurance — so report **coverage**, not a verdict: which requirements and documents you actually traced, which you could not (needs a running environment, needs domain knowledge, out of scope of this diff), and where an adversarial reviewer should start. This is what makes a later miss diagnosable: not examined, or examined and missed? Those have different fixes.


Do not edit `docs/ARCHITECTURE.md` without explicit approval — it is the architect's document. Other docs may be corrected on approval. Stop and report before making changes.
