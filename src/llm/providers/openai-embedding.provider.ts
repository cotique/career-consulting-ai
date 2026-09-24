import { Injectable } from '@nestjs/common';
import { SecretsService } from '../../config/secrets.service';
import { LlmError, kindForStatus } from '../errors';
import type { EmbeddingParams, EmbeddingProvider, EmbeddingResult } from './embedding-provider.interface';
import { assertNotUnderTest } from './refuse-in-tests';

const OPENAI_EMBEDDINGS_URL = 'https://api.openai.com/v1/embeddings';

/**
 * OpenAI's own 401 body echoes the offending key back, masked but with a
 * live prefix/suffix ("Incorrect API key provided: sk-C9F...6Kn8") — found
 * the hard way, sitting in a pg-boss job's stored output after this class's
 * own error message carried the response body verbatim. Errors get logged;
 * key material must never be in one, masked or not.
 */
export function redactApiKey(text: string): string {
  return text.replace(/sk-[A-Za-z0-9*]{6,}/g, '[redacted]');
}

// The only place in the codebase allowed to talk to OpenAI — business logic
// goes through EmbeddingService (see implement-plan conventions). A single
// POST returning JSON doesn't need the openai SDK; a plain fetch is one
// fewer dependency for the one endpoint this ever calls.
@Injectable()
export class OpenAiEmbeddingProvider implements EmbeddingProvider {
  constructor(private readonly secrets: SecretsService) {}

  async embed(params: EmbeddingParams): Promise<EmbeddingResult> {
    assertNotUnderTest('OpenAiEmbeddingProvider');
    const apiKey = await this.secrets.getSecret('OPENAI_API_KEY');

    let res: Response;
    try {
      res = await fetch(OPENAI_EMBEDDINGS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: params.model, input: params.input }),
      });
    } catch (err) {
      // No response at all — a socket hang-up or DNS failure. Worth another attempt.
      throw new LlmError('retryable', `OpenAI embeddings request failed: ${String(err)}`, undefined, {
        cause: err,
      });
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new LlmError(
        kindForStatus(res.status),
        `OpenAI embeddings API error (${res.status}): ${redactApiKey(body)}`,
        res.status,
      );
    }

    const json = (await res.json()) as {
      data: Array<{ embedding: number[] }>;
      usage: { prompt_tokens: number };
    };

    const vector = json.data[0]?.embedding;
    if (!vector) {
      throw new LlmError('permanent', 'OpenAI embeddings response had no vector.');
    }

    return { vector, tokens: json.usage.prompt_tokens };
  }
}
