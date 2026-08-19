import { Injectable } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import { SecretsService } from '../../config/secrets.service';
import { LlmError, kindForStatus } from '../errors';
import type {
  LlmProvider,
  ProviderCompletionParams,
  ProviderCompletionResult,
} from './provider.interface';

// The only place in the codebase allowed to import the Anthropic SDK —
// business logic goes through LlmService (see implement-plan conventions).
// That includes SDK *errors*: they are translated to the layer's taxonomy here
// so nothing downstream has to know what an APIError is.
@Injectable()
export class AnthropicProvider implements LlmProvider {
  private client: Anthropic | null = null;

  constructor(private readonly secrets: SecretsService) {}

  private async getClient(): Promise<Anthropic> {
    if (!this.client) {
      const apiKey = await this.secrets.getSecret('ANTHROPIC_API_KEY');
      this.client = new Anthropic({ apiKey });
    }
    return this.client;
  }

  async complete(params: ProviderCompletionParams): Promise<ProviderCompletionResult> {
    const client = await this.getClient();

    let response: Anthropic.Message;
    try {
      response = await client.messages.create({
        model: params.model,
        max_tokens: params.maxTokens,
        system: params.system,
        messages: [{ role: 'user', content: params.userMessage }],
      });
    } catch (err) {
      throw toLlmError(err);
    }

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');

    return {
      text,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      stopReason: response.stop_reason ?? undefined,
    };
  }
}

function toLlmError(err: unknown): LlmError {
  if (err instanceof Anthropic.APIError) {
    const status = err.status;
    return new LlmError(
      kindForStatus(status),
      `Anthropic API error${status ? ` (${status})` : ''}: ${err.message}`,
      status,
      { cause: err },
    );
  }
  // No status at all — a socket hang-up or DNS failure. Worth another attempt.
  return new LlmError('retryable', `Anthropic request failed: ${String(err)}`, undefined, {
    cause: err,
  });
}
