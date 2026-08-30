import { createHash } from 'node:crypto';

/**
 * The largest paste accepted. A job posting is a few kilobytes; this is roomy
 * for the worst agency listing and still a bound.
 *
 * It is a spend control, not a storage one. The LLM layer's per-attempt ceiling
 * is computed from `maxTokens`, which bounds the *output* — nothing there
 * bounds how much text a caller can push into the input half of a paid call.
 * This does, before any of it reaches a provider.
 */
export const MAX_PASTE_CHARS = 60_000;

/**
 * The text a duplicate check compares.
 *
 * Whitespace and case only. The point is to recognise the *same posting pasted
 * twice* — through a different browser, with the selection starting a line
 * earlier, with tabs where there were spaces — and nothing more ambitious than
 * that. Every normalisation beyond this trades a real false-positive risk for a
 * few more true matches: strip punctuation and two roles from the same agency
 * template start colliding.
 *
 * Recognising the same posting copied from *another board* is a different
 * problem, deliberately not attempted here: it needs a derived identity key
 * whose accuracy is unmeasured, and a wrong link is invisible exactly where it
 * does damage.
 */
export function normaliseForHash(rawText: string): string {
  return rawText.replace(/\s+/g, ' ').trim().toLowerCase();
}

export function hashOf(rawText: string): string {
  return createHash('sha256').update(normaliseForHash(rawText)).digest('hex');
}
