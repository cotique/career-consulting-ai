import { createHash } from 'node:crypto';

/**
 * How far under `text-embedding-3-small`'s real input ceiling (~8,191
 * tokens, roughly 32,000 characters at 4 chars/token) this stays. Vacancy
 * postings can reach `MAX_PASTE_CHARS` (60,000, see src/intake/paste.ts) —
 * well over the model's limit — so this must truncate rather than assume
 * a source row fits. Real sliding-window splitting for a long posting is a
 * later data change (the schema's `chunkIndex` already allows it), not
 * something this first cut attempts.
 */
export const MAX_EMBED_CHARS = 24_000;

/** One resume extraction renders to one chunk — a bounded JSON blob, no real chunking need yet. */
export function renderResumeExtractionText(structuredJson: unknown): string {
  return JSON.stringify(structuredJson).slice(0, MAX_EMBED_CHARS);
}

/** One vacancy renders to one chunk, from the text as pasted. */
export function renderVacancyText(rawText: string): string {
  return rawText.slice(0, MAX_EMBED_CHARS);
}

/**
 * Detects "the source row changed" (docs/ARCHITECTURE.md's definition of
 * stale) over the exact chunk text. Deliberately not `src/intake/paste.ts`'s
 * `hashOf` — that one normalises case and whitespace, because its job is
 * recognising the *same posting pasted twice*. Reused here it would hide a
 * real content change that happened to be case-only, silently skipping the
 * re-embed a stale chunk needs.
 */
export function contentHashOf(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
