import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createAdminDb, createTestDb, withUserContext } from '../db/test-db';
import * as schema from '../db/schema';
import { conversationUsage } from './budget.guard';
import { LlmSchemaError } from './errors';
import { FakeProvider } from './providers/fake.provider';
import { LlmService } from './llm.service';
import { onboardingParse } from './templates/onboarding-parse';
import { ONBOARDING_FREE_TEXT } from './templates';
import {
  AttemptCostExceededError,
  BudgetExceededError,
  ConversationLimitError,
  LlmTruncatedError,
  type LlmRequest,
} from './types';

// Integration layer: LlmService against the real local Postgres, through
// app_user + RLS (same contract a real request has).
// Provider is always the fake — no real LLM calls in tests.
const { db: adminDb, pool: adminPool } = createAdminDb();
const { pool: appPool } = createTestDb();

const userId = '66666666-6666-6666-6666-666666666666';

function makeService(fake: FakeProvider) {
  return LlmService.withProviders({ anthropic: fake }, appPool);
}

function makeRequest(overrides: Partial<LlmRequest> = {}): LlmRequest {
  return {
    template: 'onboarding_parse',
    userId,
    untrusted: { [ONBOARDING_FREE_TEXT]: 'Remote PM roles in Warsaw.' },
    ...overrides,
  };
}

function jsonResult(body: unknown, inputTokens = 100, outputTokens = 50) {
  return { text: JSON.stringify(body), inputTokens, outputTokens };
}

async function usageRows() {
  return adminDb.select().from(schema.llmUsageLogs).where(eq(schema.llmUsageLogs.userId, userId));
}

describe('LlmService (integration)', () => {
  beforeEach(async () => {
    delete process.env.LLM_MONTHLY_BUDGET_USD;
    delete process.env.LLM_MAX_ATTEMPT_COST_USD;
    await adminDb.delete(schema.users).where(eq(schema.users.id, userId));
    await adminDb.insert(schema.users).values({ id: userId });
  });

  it('completes a call and writes one correct usage row', async () => {
    const fake = new FakeProvider({ text: 'parsed!', inputTokens: 200, outputTokens: 80 });
    const service = makeService(fake);

    const response = await service.complete(makeRequest());

    expect(response.text).toBe('parsed!');
    expect(response.model).toBe('claude-haiku-4-5');
    // 200/1M * $1 + 80/1M * $5
    expect(response.costEstimateUsd).toBeCloseTo(0.0006);

    const rows = await usageRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].taskType).toBe('onboarding_parsing');
    expect(rows[0].provider).toBe('anthropic');
    expect(rows[0].model).toBe('claude-haiku-4-5');
    expect(rows[0].inputTokens).toBe(200);
    expect(rows[0].outputTokens).toBe(80);
    expect(Number(rows[0].costEstimate)).toBeCloseTo(0.0006);
  });

  // The point of the registry (retro-audit 3.4): the version that labels the
  // spend comes from the same object as the prompt text, so the two can't drift.
  it('takes promptVersion from the registry, not from the caller', async () => {
    const service = makeService(new FakeProvider());
    const response = await service.complete(makeRequest());

    expect(response.promptVersion).toBe(onboardingParse.version);
    const [row] = await usageRows();
    expect(row.promptVersion).toBe(onboardingParse.version);
  });

  it('refuses an untrusted label the template does not declare, before spending', async () => {
    const fake = new FakeProvider();
    const service = makeService(fake);

    await expect(
      service.complete(makeRequest({ untrusted: { 'smuggled input': 'hello' } })),
    ).rejects.toThrow(/does not declare/);

    expect(fake.calls).toHaveLength(0);
    expect(await usageRows()).toHaveLength(0);
  });

  it("another user cannot see this user's usage rows (RLS)", async () => {
    const otherUserId = '77777777-7777-7777-7777-777777777777';
    await adminDb.delete(schema.users).where(eq(schema.users.id, otherUserId));
    await adminDb.insert(schema.users).values({ id: otherUserId });

    const service = makeService(new FakeProvider());
    await service.complete(makeRequest());

    // Read as the *other* user: the point is that RLS hides the row, so the
    // query has to run under that user's context rather than the writer's.
    const visibleToOther = await withUserContext(appPool, otherUserId, (db) =>
      db.select().from(schema.llmUsageLogs),
    );
    expect(visibleToOther).toHaveLength(0);
  });
});

describe('structured output with bounded retry (retro-audit 3.5)', () => {
  const Schema = z.object({ workMode: z.enum(['remote', 'hybrid', 'onsite']) });

  beforeEach(async () => {
    delete process.env.LLM_MONTHLY_BUDGET_USD;
    delete process.env.LLM_MAX_ATTEMPT_COST_USD;
    await adminDb.delete(schema.users).where(eq(schema.users.id, userId));
    await adminDb.insert(schema.users).values({ id: userId });
  });

  it('returns validated data on the first attempt', async () => {
    const fake = new FakeProvider(jsonResult({ workMode: 'remote' }));
    const { data, attempts } = await makeService(fake).completeStructured(makeRequest(), Schema);

    expect(data.workMode).toBe('remote');
    expect(attempts).toBe(1);
    expect(fake.calls).toHaveLength(1);
  });

  it('retries once with the validation issues fed back, and succeeds', async () => {
    const fake = new FakeProvider([
      jsonResult({ workMode: 'whatever' }), // not in the enum
      jsonResult({ workMode: 'hybrid' }),
    ]);

    const { data, attempts } = await makeService(fake).completeStructured(makeRequest(), Schema);

    expect(data.workMode).toBe('hybrid');
    expect(attempts).toBe(2);
    expect(fake.calls).toHaveLength(2);

    // The correction goes into the system prompt, and carries the issue —
    // never the rejected output, which is untrusted model text.
    expect(fake.calls[1].system).toContain('did not match the required schema');
    expect(fake.calls[1].system).toContain('workMode');
    expect(fake.calls[1].system).not.toContain('whatever');

    // Both attempts are paid calls, so both are metered (retro-audit 4.1).
    expect(await usageRows()).toHaveLength(2);
  });

  it('gives up after two attempts with a permanent, typed failure', async () => {
    const fake = new FakeProvider(jsonResult({ workMode: 'nonsense' }));

    const error = await makeService(fake)
        .completeStructured(makeRequest(), Schema)
        .then(() => null)
        .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(LlmSchemaError);
    expect((error as LlmSchemaError).kind).toBe('permanent');
    expect((error as LlmSchemaError).attempts).toBe(2);
    expect(fake.calls).toHaveLength(2);
    expect(await usageRows()).toHaveLength(2);
  });

  // Raised by a question worth asking: if the JSON is cut off mid-object, does
  // the retry just do it again? It would have — and reported a schema mismatch
  // while doing it, sending the search to the prompt instead of the length.
  it('stops immediately when the response was truncated, without paying for a retry', async () => {
    const fake = new FakeProvider({
      text: '{"workMode": "rem',
      inputTokens: 100,
      outputTokens: 50,
      stopReason: 'max_tokens',
    });

    const error = await makeService(fake)
        .completeStructured(makeRequest(), Schema)
        .then(() => null)
        .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(LlmTruncatedError);
    expect((error as LlmTruncatedError).kind).toBe('permanent');
    expect(fake.calls).toHaveLength(1); // no second attempt
    expect(await usageRows()).toHaveLength(1); // and only one call paid for
  });

  it('treats unparseable prose as a validation issue rather than crashing', async () => {
    const fake = new FakeProvider([
      { text: 'Sure! Here you go, no JSON though.', inputTokens: 10, outputTokens: 10 },
      jsonResult({ workMode: 'onsite' }),
    ]);

    const { data } = await makeService(fake).completeStructured(makeRequest(), Schema);
    expect(data.workMode).toBe('onsite');
  });
});

describe('budget guards', () => {
  beforeEach(async () => {
    delete process.env.LLM_MONTHLY_BUDGET_USD;
    delete process.env.LLM_MAX_ATTEMPT_COST_USD;
    await adminDb.delete(schema.users).where(eq(schema.users.id, userId));
    await adminDb.insert(schema.users).values({ id: userId });
  });

  it('hard-blocks once monthly spend reaches the cap, without calling the provider', async () => {
    process.env.LLM_MONTHLY_BUDGET_USD = '5';
    await adminDb.insert(schema.llmUsageLogs).values({
      userId,
      taskType: 'tailoring',
      promptVersion: 'seed-v1',
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      inputTokens: 1,
      outputTokens: 1,
      costEstimate: '5.00',
    });

    const fake = new FakeProvider();
    await expect(
      makeService(fake).complete(makeRequest()),
    ).rejects.toThrow(BudgetExceededError);

    expect(fake.calls).toHaveLength(0);
    expect(await usageRows()).toHaveLength(1); // only the seeded row
  });

  it('allows calls while under the cap and only counts the current month', async () => {
    process.env.LLM_MONTHLY_BUDGET_USD = '5';
    // Last month's spend must not count against this month's cap.
    await adminDb.insert(schema.llmUsageLogs).values({
      userId,
      taskType: 'tailoring',
      promptVersion: 'seed-v1',
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      inputTokens: 1,
      outputTokens: 1,
      costEstimate: '100.00',
      createdAt: new Date(Date.now() - 45 * 24 * 60 * 60 * 1000),
    });

    const fake = new FakeProvider();
    const response = await makeService(fake).complete(makeRequest());
    expect(response.text).toBe('fake response');
    expect(fake.calls).toHaveLength(1);
  });

  // Retro-audit 4.1: the monthly cap can't see a single request that would
  // blow through it in one shot — an oversized maxTokens, or a task rerouted
  // to a much dearer model. This refuses while it is still free to refuse.
  it('refuses a single attempt whose worst case exceeds the per-attempt ceiling', async () => {
    process.env.LLM_MAX_ATTEMPT_COST_USD = '0.01';
    const fake = new FakeProvider();

    await expect(
      // 64k output tokens at $5/Mtok ≈ $0.32, well past the $0.01 ceiling.
        makeService(fake).complete(makeRequest({ maxTokens: 64_000 })),
    ).rejects.toThrow(AttemptCostExceededError);

    expect(fake.calls).toHaveLength(0);
    expect(await usageRows()).toHaveLength(0);
  });
});

describe('conversation accounting (retro-audit 4.2)', () => {
  const conversationId = 'conv-step-d-1';

  beforeEach(async () => {
    delete process.env.LLM_MONTHLY_BUDGET_USD;
    delete process.env.LLM_MAX_ATTEMPT_COST_USD;
    await adminDb.delete(schema.users).where(eq(schema.users.id, userId));
    await adminDb.insert(schema.users).values({ id: userId });
  });

  it('tags usage rows with the conversation', async () => {
    const service = makeService(new FakeProvider());
    await service.complete(makeRequest({ conversationId }));

    const [row] = await usageRows();
    expect(row.conversationId).toBe(conversationId);
  });

  it('refuses a turn past the cap without calling the provider', async () => {
    const fake = new FakeProvider();
    const service = makeService(fake);

    await service.complete(makeRequest({ conversationId, maxTurns: 2 }));
    await service.complete(makeRequest({ conversationId, maxTurns: 2 }));
    expect(fake.calls).toHaveLength(2);

    await expect(
      service.complete(makeRequest({ conversationId, maxTurns: 2 })),
    ).rejects.toThrow(ConversationLimitError);

    expect(fake.calls).toHaveLength(2); // the third turn never reached it
  });

  // Found in code review: the turn check ran once per call while every attempt
  // wrote a row, so a schema retry silently spent one of the user's turns —
  // at coaching's ≤7 cap, two bad validations would cost a third of the
  // conversation for something the user never did.
  it('charges a schema retry to the budget but not to the turn count', async () => {
    const fake = new FakeProvider([
      jsonResult({ workMode: 'nope' }),
      jsonResult({ workMode: 'remote' }),
    ]);
    const service = makeService(fake);
    const Schema = z.object({ workMode: z.enum(['remote', 'hybrid', 'onsite']) });

    await service.completeStructured(makeRequest({ conversationId, maxTurns: 2 }), Schema);

    // Two paid calls, two metered rows — but only one turn used.
    expect(fake.calls).toHaveLength(2);
    expect(await usageRows()).toHaveLength(2);

    const usage = await withUserContext(appPool, userId, (db) =>
      conversationUsage(db, userId, conversationId),
    );
    expect(usage.turns).toBe(1);
    expect(usage.costUsd).toBeGreaterThan(0);

    // And the second turn is still allowed, because the retry didn't take it.
    await service.completeStructured(makeRequest({ conversationId, maxTurns: 2 }), Schema);
  });

  it('counts turns per conversation, not per user', async () => {
    const service = makeService(new FakeProvider());
    await service.complete(makeRequest({ conversationId, maxTurns: 1 }));

    // A different conversation starts from zero even though the user has spent.
    const response = await service.complete(makeRequest({ conversationId: 'conv-step-d-2', maxTurns: 1 }));
    expect(response.text).toBe('fake response');
  });
});

afterAll(async () => {
  await adminPool.end();
  await appPool.end();
});
