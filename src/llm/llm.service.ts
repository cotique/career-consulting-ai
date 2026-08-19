import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Pool } from 'pg';
import type { ZodType } from 'zod';
import { PG_POOL, type Database } from '../db/db.module';
import { withUserContext } from '../db/user-context';
import * as schema from '../db/schema';
import {
  assertAttemptAffordable,
  assertWithinBudget,
  assertWithinConversationLimit,
} from './budget.guard';
import { LlmSchemaError } from './errors';
import { extractJsonObject } from './json-extract';
import { estimateCostUsd } from './pricing';
import { renderRetryCorrection, renderSystem, renderUserMessage } from './prompt-render';
import { AnthropicProvider } from './providers/anthropic.provider';
import type { LlmProvider } from './providers/provider.interface';
import { stripContacts } from './scrub';
import { TASK_MODELS } from './task-config';
import { getTemplate } from './templates';
import { assertValidParams } from './templates/template.types';
import { LlmTruncatedError } from './types';
import type { LlmRequest, LlmResponse, ProviderName, UserContentBlock } from './types';

/** One retry, never more: a second failure is a prompt/schema bug, not luck. */
const MAX_STRUCTURED_ATTEMPTS = 2;

/**
 * The single entry point for every LLM call in the system (NFR11): template
 * selection, the prompt-injection rendering convention, usage logging (NFR1),
 * and the budget circuit breakers (NFR2) all live here, so no consumer can
 * accidentally bypass them.
 *
 * Callers name a registry template rather than passing instructions, so
 * `promptVersion` comes from the registry and cannot drift from the prompt it
 * labels (retro-audit 3.4).
 *
 * This layer owns its own database connections and does **not** accept one from
 * the caller. It did until 2026-08-11, on the reasoning that the connection had
 * to be the caller's user-scoped one — but sharing the caller's transaction
 * meant metering shared its fate. A failed extraction rolled back its own usage
 * rows, so two paid attempts recorded nothing, and since `assertWithinBudget`
 * reads those rows, failed calls did not count against the monthly cap (NFR2) at
 * all. Each guard and each usage row now commits in its own short transaction,
 * scoped to `request.userId` by `withUserContext` exactly as before, so a
 * caller's rollback can no longer erase evidence of money we spent.
 *
 * Keeping the provider call outside any caller transaction is the second reason:
 * a model call takes seconds, and a pooled connection held open across it is how
 * a connection pool dies under concurrency.
 */
@Injectable()
export class LlmService {
  private readonly logger = new Logger(LlmService.name);
  private readonly providers: Record<ProviderName, LlmProvider>;

  constructor(
    anthropicProvider: AnthropicProvider,
    @Inject(PG_POOL) private readonly pool: Pool,
  ) {
    this.providers = { anthropic: anthropicProvider };
  }

  /** Test seam: build the service with fake providers, no Nest DI needed. */
  static withProviders(providers: Record<ProviderName, LlmProvider>, pool: Pool): LlmService {
    const service = Object.create(LlmService.prototype) as LlmService;
    Object.assign(service, {
      logger: new Logger(LlmService.name),
      providers,
      pool,
    });
    return service;
  }

  /** Free-form text response. Use `completeStructured` when you expect JSON. */
  async complete(request: LlmRequest): Promise<LlmResponse> {
    const { response } = await this.run(request, null);
    return response;
  }

  /**
   * Validates the response against `outputSchema` and retries once with the
   * validation issues fed back (retro-audit 3.5). Both attempts are budget-
   * checked and both are logged — a retry is another paid call.
   */
  async completeStructured<T>(
    request: LlmRequest,
    outputSchema: ZodType<T>,
  ): Promise<LlmResponse & { data: T }> {
    const { response, data } = await this.run(request, outputSchema);
    return { ...response, data: data as T };
  }

  private async run<T>(
    request: LlmRequest,
    outputSchema: ZodType<T> | null,
  ): Promise<{ response: LlmResponse; data?: T }> {
    const template = getTemplate(request.template);
    const params = request.params ?? {};
    assertValidParams(params);

    const blocks = this.renderUntrusted(template.untrusted, request.untrusted);
    const baseSystem = renderSystem(template.build(params));
    const userMessage = renderUserMessage(blocks);
    const maxTokens = request.maxTokens ?? template.maxTokens;

    const { provider: providerName, model } = TASK_MODELS[template.taskType];
    const provider = this.providers[providerName];

    if (request.conversationId && request.maxTurns !== undefined) {
      await this.scoped(request.userId, (db) =>
        assertWithinConversationLimit(
          db,
          request.userId,
          request.conversationId as string,
          request.maxTurns as number,
        ),
      );
    }

    const maxAttempts = outputSchema ? MAX_STRUCTURED_ATTEMPTS : 1;
    let system = baseSystem;
    let lastIssues: string[] = [];

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // Both guards run per attempt, not per call: a retry spends real money.
      // The read is its own transaction, so it sees usage rows this same loop
      // committed on its previous attempt.
      await this.scoped(request.userId, (db) => assertWithinBudget(db, request.userId));
      assertAttemptAffordable(model, system + userMessage, maxTokens);

      const result = await provider.complete({ model, system, userMessage, maxTokens });
      const costEstimateUsd = estimateCostUsd(model, result.inputTokens, result.outputTokens);

      await this.logUsage(request, template.taskType, template.version, providerName, model, {
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        costEstimateUsd,
        attempt,
      });

      const response: LlmResponse = {
        text: result.text,
        provider: providerName,
        model,
        promptVersion: template.version,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        costEstimateUsd,
        attempts: attempt,
      };

      if (!outputSchema) {
        return { response };
      }

      const parsed = outputSchema.safeParse(extractJsonObject(result.text));
      if (parsed.success) {
        return { response, data: parsed.data };
      }

      // A response cut off at the token limit fails validation for a reason no
      // retry can address: the same input produces the same overlong output.
      // Stopping here saves a paid attempt and, more importantly, reports the
      // real cause instead of blaming the schema.
      if (result.stopReason === 'max_tokens') {
        throw new LlmTruncatedError(maxTokens, attempt);
      }

      lastIssues = parsed.error.issues.map(
        (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
      );
      system = baseSystem + renderRetryCorrection(lastIssues);
    }

    throw new LlmSchemaError(
      `Response did not match the expected schema after ${maxAttempts} attempts.`,
      lastIssues,
      maxAttempts,
    );
  }

  /**
   * Turns the caller's untrusted map into rendered blocks, in the order the
   * template declares. A missing or unexpected label fails here — before any
   * spend — rather than producing a prompt with a silently empty section.
   */
  private renderUntrusted(
    declared: readonly string[],
    supplied: Record<string, string | object>,
  ): UserContentBlock[] {
    const extra = Object.keys(supplied).filter((label) => !declared.includes(label));
    if (extra.length) {
      throw new Error(`Template does not declare untrusted input(s): ${extra.join(', ')}.`);
    }

    return declared.map((label) => {
      const value = supplied[label];
      if (value === undefined) {
        throw new Error(`Template requires untrusted input "${label}".`);
      }
      // Structured input has already been through extraction, so contacts sit
      // in a known field — strip them rather than shipping a person's email
      // and phone number to the model on every downstream call.
      const text =
        typeof value === 'string' ? value : JSON.stringify(stripContacts(value), null, 2);
      return { label, text };
    });
  }

  /**
   * One short, user-scoped transaction. Every database touch this layer makes
   * goes through here so that none of them can be caught up in a caller's
   * rollback — see the note on the class.
   */
  private scoped<T>(userId: string, work: (db: Database) => Promise<T>): Promise<T> {
    return withUserContext(this.pool, userId, work);
  }

  private async logUsage(
    request: LlmRequest,
    taskType: string,
    promptVersion: string,
    provider: ProviderName,
    model: string,
    usage: { inputTokens: number; outputTokens: number; costEstimateUsd: number; attempt: number },
  ): Promise<void> {
    try {
      await this.scoped(request.userId, (db) =>
        db.insert(schema.llmUsageLogs).values({
          userId: request.userId,
          taskType,
          promptVersion,
          conversationId: request.conversationId ?? null,
          attempt: usage.attempt,
          provider,
          model,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          costEstimate: usage.costEstimateUsd.toFixed(8),
        }),
      );
    } catch (err) {
      // Metering loss must never swallow a paid-for response, but it can't be
      // silent either — unlogged spend undermines both NFR1 and the budget cap.
      this.logger.error(
        `FAILED to log LLM usage for user ${request.userId} (${taskType}, ~$${usage.costEstimateUsd.toFixed(6)}) — spend is untracked!`,
        err as Error,
      );
    }
  }
}
