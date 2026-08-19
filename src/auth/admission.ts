import { ForbiddenException, Logger } from '@nestjs/common';

const logger = new Logger('Admission');

/**
 * Who is allowed to have an account at all (T42-adjacent, added 2026-08-10
 * after an architecture review).
 *
 * Sign-in with a valid Google account is not the same thing as permission to
 * use this system. Without an admission check, anyone who reaches the URL
 * becomes a user, and every user can spend LLM tokens up to their own monthly
 * cap — the cap is per user, so total spend would be "however many strangers
 * signed up" times the cap, with the multiplier chosen by a stranger.
 *
 * **Empty list means nobody is admitted, deliberately.** The failure this
 * guards against is a deploy that forgets to set the variable; if an unset
 * list meant "allow everyone", forgetting it would produce exactly the open
 * system this exists to prevent. Failing closed makes that mistake visible
 * (nobody can sign in) instead of expensive (anybody can).
 *
 * Entries are `provider:subject` — the provider's immutable subject id, never
 * an email. Same reasoning as the account-lookup rule: an email claim can be
 * unverified or change hands, and admission is not a place to be lenient.
 */
const ENV_VAR = 'AUTH_ALLOWED_SUBJECTS';

export function allowedSubjects(): string[] {
  return (process.env[ENV_VAR] ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function isAdmitted(provider: string, externalId: string): boolean {
  return allowedSubjects().includes(`${provider}:${externalId}`);
}

export function assertAdmitted(provider: string, externalId: string): void {
  if (!isAdmitted(provider, externalId)) {
    // Logged server-side because otherwise there is no way to learn your own
    // subject id in order to allow it — this is how the list gets bootstrapped.
    logger.warn(
      `Refused sign-in for ${provider}:${externalId} — not in ${ENV_VAR} ` +
        `(${allowedSubjects().length} entr${allowedSubjects().length === 1 ? 'y' : 'ies'} configured).`,
    );
    // The response itself says nothing about whether the account exists, is
    // known, or would be admitted with different details — a rejection is not a
    // place to help someone enumerate.
    throw new ForbiddenException('This account is not permitted to use this system.');
  }
}
