---
name: test-implementation
description: Writes and runs tests for code already implemented in career-consulting-ai (see implement-plan). Use this whenever the user asks to test, verify, add test coverage for, or confirm that a feature/workflow works for this project — e.g. "write tests for this", "does the tracker work", "add coverage for the tailoring module". Covers unit tests, pg-boss job/state-machine tests against real Postgres, and API integration tests. Does not redesign the plan or the implementation — if a test reveals a real bug, report it and ask before changing implementation logic beyond what the test task covers.
---

# Test an implementation for career-consulting-ai

## Test framework

**Vitest** — decided in the Epic 0 plan and recorded in `docs/ARCHITECTURE.md`'s Stack section. Config in `vitest.config.ts` (specs live next to the code they test: `src/**/*.spec.ts`); `vitest.setup.ts` loads `.env` so integration tests reach the local database. Not a per-session choice anymore.

## Environment pre-check for integration tests

DB integration tests hit the real local Postgres — before running them, confirm the stand is up (`docker compose ps`; if not: `docker compose up -d`) and `.env` exists (copy from `.env.example`), with migrations applied (`npm run db:migrate`). A connection error is "the stand isn't running," not "the test failed" — report the two differently. CI runs the same tests against a Postgres service container defined in `.github/workflows/ci.yml` (same image as the local stand), so integration tests are not skipped there either.

## What to test, by layer

- **Pure functions / activities** — plain unit tests. These are the cheapest tests in the system; don't skip them in favor of only testing at the workflow level.
- **Anything touching user-owned tables (RLS)** — use the helpers in `src/db/test-db.ts`, don't invent a new connection pattern: `createAdminDb()` (superuser) for seeding/teardown of multi-user fixtures, `createTestDb()` + `withUserContext()` (the `app_user` role with `app.current_user_id` scoped, same as a real post-T12 request) for the code actually under test. Running the code-under-test through the admin connection looks like it works but silently bypasses RLS — superusers aren't subject to it — so the test proves nothing about the security layer (the exact trap found and fixed in T8).
- **Background jobs (pg-boss)** — test the handler function directly with a job payload (that's where the logic lives), and separately prove the wiring against a **real pg-boss instance on the local Postgres**: enqueue → drain → assert the side effect landed in the domain tables. Two properties are worth explicit tests because they're the ones that bite in production: **idempotency** (run the same handler twice, assert no duplicate rows/effects — delivery is at-least-once) and **payload discipline** (the enqueued payload contains IDs only, no content — a regression here re-opens the GDPR erasure hole). Don't mock pg-boss itself; you'd be testing the mock.
- **State-machine transitions** (application lifecycle) — table-driven tests over allowed/forbidden status transitions plus the `application_events` rows each one writes, against real Postgres. Timers are just jobs — test the scheduling decision (was a delayed job enqueued with the right run-at?) separately from what the job does.
- **API endpoints** — don't stop at handler-level integration tests run through the test framework. Actually start the app against the local dev stand (`docker-compose`, see T2) and hit real endpoints with real HTTP calls (`curl` or equivalent) yourself — you run these, not just the user. A test that only calls the handler function directly can miss routing, middleware, and serialization bugs that only show up over real HTTP.
- **Frontend, once one exists** — Playwright end-to-end tests, run by you, not handed to the user to click through manually.
- **LLM-calling code** — don't call real LLM providers in tests (cost, flakiness, non-determinism). Test through the abstraction layer's interface with a fake/stub provider, and verify the real provider integration separately and sparingly, not on every test run.

## Always leave a sandbox for manual testing

After your own unit/API/Playwright passes are done and reported, leave the relevant local service(s) running (or give the exact command to start them) so the user can poke at it themselves — a working feature isn't fully "done" from their side until they've seen it move. Don't tear down what you started for automated testing without telling them how to bring it back up.

## Scope discipline

Test what the plan and implementation actually cover — not a wishlist of everything that could theoretically be tested on this codebase. If a real bug turns up while testing, report it clearly (what was expected, what happened, why) and ask before fixing it if the fix would go beyond what you were asked to test. Testing that quietly turns into a second, uncoordinated implementation pass defeats the purpose of having plan → implement → test as separate stages.

## A green signal is a claim, not a proof

Before any green result is allowed to support a conclusion, make it go red on demand once. A check that has never failed in your hands is indistinguishable from one that *cannot* fail, and the second kind is common:

| False-green mechanism | What actually happened | Cheap canary |
|---|---|---|
| Suite reports pass with zero executed cases | Registration worked; nothing ran | Compare the executed-case count against what you expected; assert it is non-zero |
| A nested or conditional block silently never runs | The runner never reached it | Same count, per file |
| Lint or typecheck green locally but red in CI | The local toolchain differs from the pinned one | Run what CI runs, or diff the versions explicitly |
| A job exits cleanly having dropped most of its input | Partial failure swallowed | Compare rows/items out against in; fail on shortfall |
| HTTP 200 from a fallback route read as a live endpoint | The router served something else | Check content-type and body shape, never the status alone |

Practically: insert a deliberately failing assertion, or point the check at known-bad input, and confirm the harness reports it. If a check cannot be made to fail, report the verification as **unproven** rather than passing.

## Coverage honesty

A passing suite says the change did not break what was already covered. It does not say the change works. Name **which test exercises the changed path** — or state plainly that none does. A large green suite is the easiest place in the world to hide an untested change.

## After running tests

Report in four parts, kept separate:

- **Changed** — which test files were added or modified.
- **Verified** — the commands you ran and what they printed, including executed-case counts.
- **Not verified, and why** — anything untestable here (no Postgres in the environment, an external dependency, needs a human). An empty section here is itself a claim; make sure it is true.
- **Yours next** — what the user should run or decide.

Don't present an estimate as a fact; mark status accurately — that principle applies to your own test reports as much as to the product's output.
