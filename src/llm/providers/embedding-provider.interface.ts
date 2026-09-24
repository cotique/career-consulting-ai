export interface EmbeddingParams {
  model: string;
  input: string;
}

export interface EmbeddingResult {
  vector: number[];
  /** Input tokens billed for this call — an embedding has no output tokens. */
  tokens: number;
}

export interface EmbeddingProvider {
  embed(params: EmbeddingParams): Promise<EmbeddingResult>;
}
