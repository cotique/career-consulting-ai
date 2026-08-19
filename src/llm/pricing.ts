// Static price table, USD per million tokens. Known accepted risk: this can
// drift from provider pricing over time — tracked in docs/TRADEOFFS.md;
// re-check whenever a model is added or swapped in task-config.ts.
interface ModelPricing {
  inputPerMTok: number;
  outputPerMTok: number;
}

const PRICES: Record<string, ModelPricing> = {
  'claude-haiku-4-5': { inputPerMTok: 1.0, outputPerMTok: 5.0 },
};

export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = PRICES[model];
  if (!pricing) {
    throw new Error(`No pricing entry for model "${model}" — add it to src/llm/pricing.ts.`);
  }
  return (
    (inputTokens / 1_000_000) * pricing.inputPerMTok +
    (outputTokens / 1_000_000) * pricing.outputPerMTok
  );
}

// Rough, deliberately generous: ~4 characters per token for Latin scripts.
// Only used to bound an attempt's cost *before* sending it, where erring high
// is the safe direction — the real token counts come back with the response.
const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * The most this attempt could cost: the prompt we're about to send, plus a
 * full `maxTokens` of output. Feeds the per-attempt ceiling (retro-audit 4.1).
 */
export function worstCaseAttemptCostUsd(
  model: string,
  promptText: string,
  maxTokens: number,
): number {
  return estimateCostUsd(model, estimateTokens(promptText), maxTokens);
}
