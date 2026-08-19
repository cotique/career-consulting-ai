export interface ProviderCompletionParams {
  model: string;
  system: string;
  userMessage: string;
  maxTokens: number;
}

export interface ProviderCompletionResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  /**
   * Why the model stopped. `'max_tokens'` means the response was cut off, which
   * matters because a truncated JSON object fails schema validation for a
   * reason no retry can fix — the same input produces the same overlong output.
   * Without this signal, running out of room is indistinguishable from the
   * model misunderstanding the schema, and the two need opposite responses.
   */
  stopReason?: string;
}

export interface LlmProvider {
  complete(params: ProviderCompletionParams): Promise<ProviderCompletionResult>;
}
