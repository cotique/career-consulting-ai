import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Pool } from 'pg';
import { PG_POOL, type Database } from '../db/db.module';
import { withUserContext } from '../db/user-context';
import * as schema from '../db/schema';
import { assertAttemptAffordable, assertWithinBudget } from './budget.guard';
import { estimateCostUsd } from './pricing';
import type { EmbeddingProvider } from './providers/embedding-provider.interface';
import { OpenAiEmbeddingProvider } from './providers/openai-embedding.provider';

/** "One embedding model across the system" (docs/ARCHITECTURE.md) — a single
 * value, not a per-task table like `TASK_MODELS`: nothing here chooses a
 * model per caller. */
export const EMBEDDING_MODEL = 'text-embedding-3-small';

export interface EmbedResult {
  vector: number[];
  model: string;
}

/**
 * The single entry point for embedding calls, sibling to `LlmService` rather
 * than a method on it — an embedding has no system/user split and no
 * structured-output retry, so `LlmService.run()`'s shape doesn't fit. Reuses
 * the two pieces of that layer that do generalize: the spend guards (NFR2)
 * and usage logging (NFR1) into the same `llm_usage_logs` table, so an
 * embedding call is metered and capped exactly like a completion.
 */
@Injectable()
export class EmbeddingService {
  private readonly logger = new Logger(EmbeddingService.name);
  private readonly provider: EmbeddingProvider;

  constructor(
    openAiProvider: OpenAiEmbeddingProvider,
    @Inject(PG_POOL) private readonly pool: Pool,
  ) {
    this.provider = openAiProvider;
  }

  /** Test seam: build the service with a fake provider, no Nest DI needed. */
  static withProvider(provider: EmbeddingProvider, pool: Pool): EmbeddingService {
    const service = Object.create(EmbeddingService.prototype) as EmbeddingService;
    Object.assign(service, { logger: new Logger(EmbeddingService.name), provider, pool });
    return service;
  }

  async embed(userId: string, text: string): Promise<EmbedResult> {
    await this.scoped(userId, (db) => assertWithinBudget(db, userId));
    // No output tokens for an embedding — the ceiling this bounds is purely
    // the input we're about to send.
    assertAttemptAffordable(EMBEDDING_MODEL, text, 0);

    const result = await this.provider.embed({ model: EMBEDDING_MODEL, input: text });
    const costEstimateUsd = estimateCostUsd(EMBEDDING_MODEL, result.tokens, 0);

    await this.logUsage(userId, result.tokens, costEstimateUsd);

    return { vector: result.vector, model: EMBEDDING_MODEL };
  }

  private scoped<T>(userId: string, work: (db: Database) => Promise<T>): Promise<T> {
    return withUserContext(this.pool, userId, work);
  }

  private async logUsage(userId: string, inputTokens: number, costEstimateUsd: number): Promise<void> {
    try {
      await this.scoped(userId, (db) =>
        db.insert(schema.llmUsageLogs).values({
          userId,
          taskType: 'retrieval_embedding',
          // No prompt-template registry entry for an embedding call — the
          // model name doubles as its own version marker, the same value
          // stored beside the vector itself.
          promptVersion: EMBEDDING_MODEL,
          attempt: 1,
          provider: 'openai',
          model: EMBEDDING_MODEL,
          inputTokens,
          outputTokens: 0,
          costEstimate: costEstimateUsd.toFixed(8),
        }),
      );
    } catch (err) {
      this.logger.error(
        `FAILED to log embedding usage for user ${userId} (~$${costEstimateUsd.toFixed(6)}) — spend is untracked!`,
        err as Error,
      );
    }
  }
}
