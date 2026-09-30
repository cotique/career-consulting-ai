import { LlmError } from './errors';
import type { TemplateName, TemplateParams } from './templates';

export const TASK_TYPES = [
  'vacancy_parsing',
  'vacancy_scoring',
  'resume_extraction',
  'tailoring',
  'onboarding_parsing',
  'chat',
] as const;
export type TaskType = (typeof TASK_TYPES)[number];

export type ProviderName = 'anthropic';

/**
 * Untrusted input (vacancy text, resume text, free-form user answers).
 * Kept structurally separate from template instructions so the rendering layer —
 * not each caller's prompt discipline — enforces the data-vs-instructions
 * boundary (see the LLM layer in docs/ARCHITECTURE.md).
 */
export interface UserContentBlock {
  label: string;
  text: string;
}

export interface LlmRequest {
  /** Names a template in the registry — there is no free-form instructions path. */
  template: TemplateName;
  userId: string;
  /**
   * Untrusted values keyed by the labels the template declares. Structured
   * values (extraction output) are serialized with contact fields stripped;
   * strings are passed through the data-delimiter rendering unchanged.
   */
  untrusted: Record<string, string | object>;
  /** Trusted, validated prompt parameters — language/market (retro-audit 3.9). */
  params?: TemplateParams;
  /**
   * Groups calls that belong to one conversation, so turns and spend can be
   * accounted per conversation (retro-audit 4.2). Enforcement constants (turn
   * caps per feature) arrive with the first conversational feature.
   */
  conversationId?: string;
  /** Refuses the call if the conversation already has this many turns. */
  maxTurns?: number;
  /** Overrides the template's own bound. */
  maxTokens?: number;
}

export interface LlmResponse {
  text: string;
  provider: ProviderName;
  model: string;
  promptVersion: string;
  inputTokens: number;
  outputTokens: number;
  costEstimateUsd: number;
  /** 1 unless a structured-output validation retry happened. */
  attempts: number;
}

export class BudgetExceededError extends LlmError {
  constructor(
    readonly userId: string,
    readonly spentUsd: number,
    readonly capUsd: number,
  ) {
    super(
      'budget',
      `Monthly LLM budget exceeded for user ${userId}: spent $${spentUsd.toFixed(4)} of $${capUsd.toFixed(2)} cap.`,
    );
    this.name = 'BudgetExceededError';
  }
}

/**
 * Worst-case cost of a single attempt (max_tokens × output price) exceeds the
 * per-attempt ceiling (retro-audit 4.1). Distinct from the monthly cap: this
 * catches a single runaway request — a huge `maxTokens`, or a model swapped to
 * a far more expensive one — *before* it is sent, rather than noticing after
 * the month's budget has absorbed it.
 */
export class AttemptCostExceededError extends LlmError {
  constructor(
    readonly worstCaseUsd: number,
    readonly ceilingUsd: number,
  ) {
    super(
      'budget',
      `A single attempt could cost up to $${worstCaseUsd.toFixed(4)}, over the $${ceilingUsd.toFixed(4)} per-attempt ceiling.`,
    );
    this.name = 'AttemptCostExceededError';
  }
}

/**
 * The model ran out of output room mid-answer, so the result is incomplete.
 *
 * Separate from `LlmSchemaError` because the two need opposite responses: a
 * schema mismatch is worth one retry, while a truncated response will truncate
 * again on identical input — retrying only pays twice for the same failure.
 * Reported as `permanent` for that reason: the fix is a smaller input or a
 * larger bound, not another attempt.
 */
export class LlmTruncatedError extends LlmError {
  constructor(
    readonly maxTokens: number,
    readonly attempts: number,
  ) {
    super(
      'permanent',
      `The model hit its ${maxTokens}-token output limit and the response is incomplete. ` +
        'Retrying would truncate identically — either the input is too large for one pass or the limit is too low.',
    );
    this.name = 'LlmTruncatedError';
  }
}

/**
 * Conversation turn cap tripped (retro-audit 4.2). `budget`, not `permanent`:
 * unlike a malformed request, this refusal is on purpose and starting a new
 * conversation succeeds immediately — the same "refused now, not forever"
 * shape `BudgetExceededError` already has, and `httpErrorFor` already maps
 * `budget` to 429 for exactly that reason. Chat (T19) is this error's first
 * real caller; the kind was `permanent` (a wrong, unexercised default) until
 * that mattered.
 */
export class ConversationLimitError extends LlmError {
  constructor(
    readonly conversationId: string,
    readonly turns: number,
    readonly maxTurns: number,
  ) {
    super(
      'budget',
      `Conversation ${conversationId} has reached its ${maxTurns}-turn limit (${turns} turns used).`,
    );
    this.name = 'ConversationLimitError';
  }
}
