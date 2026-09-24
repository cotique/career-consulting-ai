/**
 * Belt-and-braces: refuses a real provider call whenever the process is a
 * test run, regardless of whether Nest DI actually substituted the fake.
 *
 * Found the hard way (retrieval infrastructure, T22): a real call reached
 * OpenAI during a full-suite test run despite `retrieval.spec.ts` overriding
 * `OpenAiEmbeddingProvider` — a stray/zombie worker process from an earlier
 * test invocation, still holding the real provider wired in, picked up and
 * processed a job the test suite enqueued, using the real (here: invalid)
 * key from `.env`. DI override correctness is necessary but was not
 * sufficient; every provider must refuse for itself.
 *
 * Vitest sets `VITEST=true` on every worker process for the whole run — this
 * is not `NODE_ENV`-dependent (`.env.example` sets no NODE_ENV locally) and
 * survives exactly the failure mode above, since a leftover worker process
 * still carries the env it was spawned with.
 */
export function assertNotUnderTest(providerName: string): void {
  if (process.env.VITEST) {
    throw new Error(
      `${providerName} was about to make a real network call from a test run (VITEST is set). ` +
        'This must never happen — the test should have overridden this provider with a fake.',
    );
  }
}
