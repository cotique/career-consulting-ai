---
name: arch-review
description: Deep architecture review of career-consulting-ai as described in docs/ — cloud/hosting, AI and LLM layer, data model, load and performance, cost, security, privacy/GDPR, operability. Use when the user asks for an architecture review, a second opinion on a design, or a check on whether the described architecture still holds after a set of changes. Reviews the architecture as documented and as built; does not rewrite the docs without approval.
---

# Architecture review for career-consulting-ai

A senior-architect pass over the system as it is described *and* as it is actually built. The output is a findings report, not edits.

The reference model is the same one used for the 2026-08-09 review: read the docs as the intended design, read the code as the real one, and report where they disagree — in either direction. A doc that promises something the code doesn't do is a finding; so is code doing something load-bearing that no doc records.

## Read first

`docs/ARCHITECTURE.md` (stack, hosting, execution model, module boundaries, data-model rules, and the FR/NFR list at the end) and `docs/TRADEOFFS.md` (what is deliberately unfinished, and its revisit triggers). Beyond those two, the code is the record — there is no separate spec to compare against.

Then the code — at minimum `src/db/schema.ts`, `src/llm/`, `src/auth/`, `drizzle/` migrations.

## Dimensions

Work through these deliberately. Not every dimension will have findings; say so rather than padding.

**Scope and phase.** Is the reviewed design solving a problem the project actually has at its current phase? Over-engineering for scale that is years away is a finding in a solo side project, exactly as under-engineering would be in a funded one. MVP scope is `SPEC` §9 — flag anything that has quietly grown past it.

**Execution model.** Synchronous handler vs pg-boss job vs state machine on domain tables. Is long-lived work modeled as a state machine plus timers rather than a long-running process? Do job payloads carry IDs only (GDPR erasure), are handlers idempotent (at-least-once), and are workers drain-style (wake → drain → exit) so scale-to-zero stays possible?

**Data model.** `user_id` on every user-owned row with cascade; raw/structured split for files and PII; `prompt_version` beside anything LLM-generated; `embedding_model_version` beside any vector. Denormalization that RLS depends on. Indexes that the actual query patterns need — and indexes nobody's query will ever use.

**AI/LLM layer.** Single entry point; task→model routing; template registry as the only source of instructions; trusted/untrusted separation enforced structurally rather than by caller discipline; structured output validated with bounded retries; error taxonomy usable by job handlers; per-attempt, per-conversation and per-month cost control. Model choice vs task difficulty — paying frontier prices for extraction is a finding, and so is routing a genuinely hard task to the cheapest model.

**Cost.** Where does money actually leave? LLM tokens, storage, egress, always-on compute. Is there a hard stop, not just a dashboard? What is the worst case for a single runaway request or loop?

**Load and performance.** What is the realistic concurrency (for this project: one user, occasionally a batch)? Where would the first real bottleneck be — and is the design's answer proportionate? N+1 queries, per-row subqueries in RLS policies, unbounded result sets, work done synchronously that a user is waiting on.

**Security.** Authentication and session handling; authorization at both the API layer and the database layer; identity/account-linking rules; injection surfaces (SQL, prompt); secret handling and where secrets live at rest; blast radius of a compromised component. Prefer mechanisms that make the mistake impossible over conventions that require remembering.

**Privacy and GDPR.** What personal data exists, where it is stored, where it is *processed* (including which jurisdiction an LLM call lands in), how deletion actually cascades — including blobs and queue payloads — and whether an export is genuinely complete.

**Operability.** How is a failure noticed? What does a deploy look like, what does a rollback look like, what happens to in-flight jobs? Backups, and whether a restore has ever been rehearsed. Solo-operator burden is a first-class constraint here: a design that needs an on-call rotation is the wrong design for this project.

**Evolution.** Which decisions are cheap to reverse and which are one-way doors? Are the one-way doors the ones that got the most thought?

## Reporting

A table per dimension: finding, current state, severity, and a proposed fix. Severity uses this project's existing scale — **[E<N>]** blocks a specific epic, **[MVP]** fix before MVP ships, **[C]** cosmetic.

Rules for the report:
- **Verify before asserting.** If a claim depends on how a library, cloud service, or API actually behaves, check it (docs, source, a real call) and cite what you checked. Never produce a plausible-sounding infrastructure fact from memory — if it can't be verified, say "unverified" and stop.
- Separate "this is wrong" from "this is unrecorded". A deliberate shortcut that's already in `TRADEOFFS.md` with a trigger is not a finding; the same shortcut undocumented is.
- Propose the *smallest* fix that closes the finding, and name what it costs.
- If a finding can't be acted on yet (needs infrastructure that doesn't exist), say so and name the task it belongs to.

### An empty result is a null result

A review that reports nothing is weak evidence, not assurance — so report **coverage**, not a verdict: which dimensions you actually examined, which you could not (needs a running environment, needs domain knowledge, out of scope of this diff), and where an adversarial reviewer should start. This is what makes a later miss diagnosable: not examined, or examined and missed? Those have different fixes.


End with a proposed execution order if there are several findings, and stop for approval before implementing anything. Large refactors always wait for an explicit go-ahead.
