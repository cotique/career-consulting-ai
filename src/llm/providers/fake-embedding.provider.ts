import type { EmbeddingParams, EmbeddingProvider, EmbeddingResult } from './embedding-provider.interface';

// 1536 dimensions to match the real `vector(1536)` columns — a shorter fake
// vector would fail against real Postgres in an integration test, not just
// look unrealistic.
const DEFAULT_RESULT: EmbeddingResult = {
  vector: Array.from({ length: 1536 }, (_, i) => Math.sin(i)),
  tokens: 10,
};

/**
 * Test/local-dev stand-in — never calls OpenAI (test-implementation
 * convention: no real LLM/embedding calls in tests). Records every call so
 * tests can assert e.g. that a hash-unchanged row never reached the provider.
 */
export class FakeEmbeddingProvider implements EmbeddingProvider {
  calls: EmbeddingParams[] = [];
  private readonly result: EmbeddingResult;

  constructor(result: EmbeddingResult = DEFAULT_RESULT) {
    this.result = result;
  }

  async embed(params: EmbeddingParams): Promise<EmbeddingResult> {
    this.calls.push(params);
    return this.result;
  }
}
