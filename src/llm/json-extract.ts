/**
 * Models often wrap JSON in prose or a code fence. Recovering the object is
 * the layer's job, not each caller's — otherwise every consumer reimplements
 * the same slightly-different salvage logic.
 *
 * Returns null rather than throwing: for structured output a parse failure is
 * just the first validation issue, and it feeds the bounded retry like any
 * other.
 */
export function extractJsonObject(text: string): unknown | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}
