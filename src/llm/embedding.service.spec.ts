import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createAdminDb, createTestDb } from '../db/test-db';
import * as schema from '../db/schema';
import { EMBEDDING_MODEL, EmbeddingService } from './embedding.service';
import { AttemptCostExceededError, BudgetExceededError } from './types';
import { FakeEmbeddingProvider } from './providers/fake-embedding.provider';

// Integration layer: EmbeddingService against the real local Postgres,
// through app_user + RLS — same contract llm-usage.spec.ts holds LlmService
// to. Provider is always the fake — no real OpenAI calls in tests.
const { db: adminDb, pool: adminPool } = createAdminDb();
const { pool: appPool } = createTestDb();

const userId = '77777777-7777-7777-7777-777777777777';

function makeService(fake: FakeEmbeddingProvider) {
  return EmbeddingService.withProvider(fake, appPool);
}

async function usageRows() {
  return adminDb.select().from(schema.llmUsageLogs).where(eq(schema.llmUsageLogs.userId, userId));
}

describe('EmbeddingService (integration)', () => {
  beforeEach(async () => {
    delete process.env.LLM_MONTHLY_BUDGET_USD;
    delete process.env.LLM_MAX_ATTEMPT_COST_USD;
    await adminDb.delete(schema.users).where(eq(schema.users.id, userId));
    await adminDb.insert(schema.users).values({ id: userId });
  });

  afterAll(async () => {
    await adminDb.delete(schema.users).where(eq(schema.users.id, userId));
    await adminPool.end();
    await appPool.end();
  });

  it('embeds and writes one correct usage row', async () => {
    const fake = new FakeEmbeddingProvider({ vector: [0.1, 0.2, 0.3], tokens: 42 });
    const service = makeService(fake);

    const result = await service.embed(userId, 'some resume text');

    expect(result.model).toBe(EMBEDDING_MODEL);
    expect(result.vector).toEqual([0.1, 0.2, 0.3]);

    const rows = await usageRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      taskType: 'retrieval_embedding',
      provider: 'openai',
      model: EMBEDDING_MODEL,
      inputTokens: 42,
      outputTokens: 0,
    });
  });

  it('refuses once the monthly cap is spent, before calling the provider', async () => {
    process.env.LLM_MONTHLY_BUDGET_USD = '0.00000001';
    const fake = new FakeEmbeddingProvider({ vector: [0.1], tokens: 1_000_000 });
    const service = makeService(fake);

    await service.embed(userId, 'first call spends past the cap');
    await expect(service.embed(userId, 'second call')).rejects.toThrow(BudgetExceededError);

    expect(fake.calls).toHaveLength(1);
  });

  it('refuses a single attempt whose worst case exceeds the per-attempt ceiling', async () => {
    process.env.LLM_MAX_ATTEMPT_COST_USD = '0.00000001';
    const fake = new FakeEmbeddingProvider();
    const service = makeService(fake);

    await expect(service.embed(userId, 'x'.repeat(10_000))).rejects.toThrow(AttemptCostExceededError);
    expect(fake.calls).toHaveLength(0);
  });
});
