import type {
  LlmProvider,
  ProviderCompletionParams,
  ProviderCompletionResult,
} from './provider.interface';

const DEFAULT_RESULT: ProviderCompletionResult = {
  text: 'fake response',
  inputTokens: 100,
  outputTokens: 50,
};

/**
 * Test/local-dev stand-in — never calls a real provider (test-implementation
 * convention: no real LLM calls in tests). Records every call so tests can
 * assert e.g. that a budget-blocked request never reached the provider.
 *
 * Accepts a sequence of results so a test can make the first attempt fail
 * validation and the second succeed — the bounded-retry path.
 */
export class FakeProvider implements LlmProvider {
  calls: ProviderCompletionParams[] = [];
  private readonly results: ProviderCompletionResult[];

  constructor(result: ProviderCompletionResult | ProviderCompletionResult[] = DEFAULT_RESULT) {
    this.results = Array.isArray(result) ? result : [result];
  }

  async complete(params: ProviderCompletionParams): Promise<ProviderCompletionResult> {
    this.calls.push(params);
    // The last result repeats, so a single-result fake behaves as before.
    return this.results[Math.min(this.calls.length - 1, this.results.length - 1)];
  }
}
