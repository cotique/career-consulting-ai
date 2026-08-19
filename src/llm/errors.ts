/**
 * Retry/error taxonomy (retro-audit 3.6).
 *
 * The point is not prettier errors — it is that a pg-boss handler must be able
 * to decide "retry this job" vs "dead-letter it" vs "stop spending" without
 * pattern-matching on provider SDK internals. Every failure leaving this layer
 * carries one of three kinds:
 *
 * - `retryable` — transient: rate limits, 5xx, timeouts, connection resets.
 *   A job handler should let pg-boss retry with backoff.
 * - `permanent` — the request itself is wrong: 4xx that won't change on retry, or
 *   output that failed schema validation even after the bounded retry.
 *   Retrying burns money for the same result; dead-letter it.
 * - `budget` — spending guard tripped. Not a failure of the request; retrying
 *   later (next month, or after the cap is raised) may succeed, but retrying
 *   *now* must not happen.
 */
export type LlmErrorKind = 'retryable' | 'permanent' | 'budget';

export class LlmError extends Error {
  constructor(
    readonly kind: LlmErrorKind,
    message: string,
    readonly status?: number,
    options?: { cause?: unknown },
  ) {
    super(message, options as ErrorOptions);
    this.name = 'LlmError';
  }
}

export class LlmSchemaError extends LlmError {
  constructor(
    message: string,
    readonly issues: string[],
    readonly attempts: number,
  ) {
    super('permanent', message);
    this.name = 'LlmSchemaError';
  }
}

/**
 * Maps an HTTP status to a kind. 408/409/429 and 5xx are worth another
 * attempt; everything else in 4xx is our bug or our config and will fail
 * identically next time.
 */
export function kindForStatus(status: number | undefined): LlmErrorKind {
  if (status === undefined) return 'retryable'; // no response at all — network
  if (status === 408 || status === 409 || status === 429) return 'retryable';
  if (status >= 500) return 'retryable';
  return 'permanent';
}
