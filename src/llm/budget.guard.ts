import { and, count, eq, gte, sql, sum } from 'drizzle-orm';
import type { Database } from '../db/db.module';
import * as schema from '../db/schema';
import { worstCaseAttemptCostUsd } from './pricing';
import { AttemptCostExceededError, BudgetExceededError, ConversationLimitError } from './types';

// Non-secret config — plain env is fine here (SecretsService is for secrets).
const DEFAULT_CAP_USD = 10;
const DEFAULT_ATTEMPT_CEILING_USD = 0.5;

function positiveEnvNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function monthlyBudgetCapUsd(): number {
  return positiveEnvNumber('LLM_MONTHLY_BUDGET_USD', DEFAULT_CAP_USD);
}

export function attemptCostCeilingUsd(): number {
  return positiveEnvNumber('LLM_MAX_ATTEMPT_COST_USD', DEFAULT_ATTEMPT_CEILING_USD);
}

/**
 * NFR2's circuit breaker: hard-blocks new LLM calls once the user's current
 * calendar month spend reaches the cap. Known accepted limitation:
 * check-then-call is not transactional, so parallel in-flight requests can
 * overshoot the cap by a few requests' worth — fine for a solo user;
 * revisit if multi-user ever ships.
 *
 * Runs before *every* provider attempt, including structured-output retries
 * (retro-audit 4.1) — a retry is another paid call, not a free do-over.
 *
 * `db` must be a user-scoped connection (RLS session context set) — same
 * contract as user-data.ts. RLS also independently hides other users' rows.
 */
export async function assertWithinBudget(db: Database, userId: string): Promise<void> {
  const capUsd = monthlyBudgetCapUsd();

  const [row] = await db
    .select({ spent: sum(schema.llmUsageLogs.costEstimate) })
    .from(schema.llmUsageLogs)
    .where(
      and(
        eq(schema.llmUsageLogs.userId, userId),
        gte(schema.llmUsageLogs.createdAt, sql`date_trunc('month', now())`),
      ),
    );

  const spentUsd = row?.spent ? Number(row.spent) : 0;
  if (spentUsd >= capUsd) {
    throw new BudgetExceededError(userId, spentUsd, capUsd);
  }
}

/**
 * Bounds one attempt before it is sent (retro-audit 4.1). The monthly cap
 * catches accumulated spend; this catches a single request that could blow a
 * large hole in one go — an oversized `maxTokens`, or a task routed to a much
 * more expensive model — while it is still free to refuse.
 */
export function assertAttemptAffordable(model: string, promptText: string, maxTokens: number): void {
  const ceilingUsd = attemptCostCeilingUsd();
  const worstCaseUsd = worstCaseAttemptCostUsd(model, promptText, maxTokens);
  if (worstCaseUsd > ceilingUsd) {
    throw new AttemptCostExceededError(worstCaseUsd, ceilingUsd);
  }
}

/**
 * Turns and spend so far in one conversation (retro-audit 4.2).
 *
 * `turns` counts first attempts only: a structured-output retry costs money
 * (and so counts toward `costUsd`) but is the model failing to follow a
 * schema, not the user taking another turn.
 *
 * Filtered by `user_id` as well as conversation even though RLS already scopes
 * the rows — same belt-and-braces as the monthly check, so a colliding
 * conversation id can't make one user's cap depend on another's traffic.
 */
export async function conversationUsage(
  db: Database,
  userId: string,
  conversationId: string,
): Promise<{ turns: number; costUsd: number }> {
  const [row] = await db
    .select({
      turns: count(sql`CASE WHEN ${schema.llmUsageLogs.attempt} = 1 THEN 1 END`),
      spent: sum(schema.llmUsageLogs.costEstimate),
    })
    .from(schema.llmUsageLogs)
    .where(
      and(
        eq(schema.llmUsageLogs.userId, userId),
        eq(schema.llmUsageLogs.conversationId, conversationId),
      ),
    );

  return { turns: Number(row?.turns ?? 0), costUsd: row?.spent ? Number(row.spent) : 0 };
}

/**
 * Refuses a call that would exceed a conversation's turn cap. The *mechanism*
 * landed ahead of any caller; chat (T19) is the first real one, at 50 turns
 * (src/chat/chat.service.ts) — loose since the monthly spend cap (NFR2) is
 * the real backstop, this only bounds one conversation's share of it.
 * Coaching/mock-interviews/wellbeing remain unbuilt; each gets its own
 * constant, chosen for its own shape, when it lands.
 */
export async function assertWithinConversationLimit(
  db: Database,
  userId: string,
  conversationId: string,
  maxTurns: number,
): Promise<void> {
  const { turns } = await conversationUsage(db, userId, conversationId);
  if (turns >= maxTurns) {
    throw new ConversationLimitError(conversationId, turns, maxTurns);
  }
}
