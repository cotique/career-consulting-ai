/**
 * Contact-field stripping (retro-audit 3.7).
 *
 * Extraction produces structured JSON with contact details isolated in one
 * field (`CONTACTS_FIELD`). Anything that goes back *into* a later prompt —
 * scoring a vacancy against an extracted resume, tailoring a document — gets
 * stripped first, so a person's email and phone number are not shipped to a
 * model on every downstream call that merely needs their experience.
 *
 * This is enforced by the layer rather than by caller discipline: structured
 * values passed as untrusted template input are run through `stripContacts`
 * on the way in (see llm.service.ts), so forgetting to call it is not a
 * failure mode a consumer can have.
 */
export const CONTACTS_FIELD = 'contacts';

const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
// Loose on purpose: over-redacting a number in free text is cheap, leaking a
// phone number is not. Requires 8+ digits so years and salaries survive.
const PHONE = /(?:\+\d[\d\s().-]{7,}\d)|(?:\b\d[\d\s().-]{7,}\d\b)/g;

export const REDACTED = '[redacted]';

/**
 * Deep-removes the conventional contacts field from a structured value.
 * Returns a copy; the input is not mutated.
 */
export function stripContacts(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripContacts);
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (key === CONTACTS_FIELD) continue;
      out[key] = stripContacts(val);
    }
    return out;
  }
  return value;
}

/**
 * Redacts contact patterns from free text. The structured path above is the
 * primary mechanism; this is the fallback for raw text (a pasted resume) that
 * has not been through extraction yet.
 */
export function redactContactText(text: string): string {
  return text.replace(EMAIL, REDACTED).replace(PHONE, REDACTED);
}
