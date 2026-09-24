import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from '../app.module';
import { AnthropicProvider } from './providers/anthropic.provider';
import { FakeEmbeddingProvider } from './providers/fake-embedding.provider';
import { FakeProvider } from './providers/fake.provider';
import { OpenAiEmbeddingProvider } from './providers/openai-embedding.provider';

/**
 * T22 incident regression: a real network call reached OpenAI from inside a
 * full-suite test run because a spec file that never overrides
 * `OpenAiEmbeddingProvider` still boots the full `AppModule`, and its own
 * instance of that provider is a genuine, reachable competing consumer for
 * any job another spec file enqueues on a shared pg-boss queue. The fix —
 * `LlmModule` defaulting both real providers to their fakes whenever
 * `VITEST` is set — has nothing else proving it structurally: every other
 * spec file that boots `AppModule` either overrides these tokens itself
 * (masking a reversion) or never resolves them at all. This is deliberately
 * the one spec file that does neither.
 */
let app: INestApplication;

beforeAll(async () => {
  // No `.overrideProvider(...)` at all — this is the exact "a spec file
  // with no reason to care" shape that caused the incident.
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  await app.init();
});

afterAll(async () => {
  await app?.close();
});

describe('LlmModule provider defaults under test (T22 incident fix)', () => {
  it('resolves AnthropicProvider to the fake, un-overridden', () => {
    expect(app.get(AnthropicProvider)).toBeInstanceOf(FakeProvider);
  });

  it('resolves OpenAiEmbeddingProvider to the fake, un-overridden', () => {
    expect(app.get(OpenAiEmbeddingProvider)).toBeInstanceOf(FakeEmbeddingProvider);
  });
});
