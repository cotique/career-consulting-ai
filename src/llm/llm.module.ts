import { Global, Module, type OnModuleInit } from '@nestjs/common';
import { EmbeddingService } from './embedding.service';
import { AnthropicProvider } from './providers/anthropic.provider';
import { FakeEmbeddingProvider } from './providers/fake-embedding.provider';
import { FakeProvider } from './providers/fake.provider';
import { OpenAiEmbeddingProvider } from './providers/openai-embedding.provider';
import { LlmService } from './llm.service';
import { assertTemplateTextAvailable } from './templates';

/**
 * Under a test run (VITEST is set on every Vitest worker), the real
 * provider is backed by its fake **by default** — not only in the spec
 * files that think to override it. Every spec file boots the full
 * `AppModule`, and every domain module's pg-boss handler (T21's tracker,
 * T22's retrieval) registers against a queue in the one shared local
 * Postgres — a spec file with no reason to care about retrieval still ends
 * up a genuine, reachable competing consumer for a job a *different* spec
 * file enqueues on that queue. Found the hard way: an unrelated spec
 * file's un-overridden `OpenAiEmbeddingProvider` picked up and nearly ran a
 * real (here: invalid) `OPENAI_API_KEY` against OpenAI, from inside a
 * full-suite run, because that file never had a reason to override it. A
 * spec file can still `.overrideProvider(...)` its own fake on top of this
 * — this only changes what "un-overridden" means under test.
 */
const anthropicProviderDefinition = process.env.VITEST
  ? { provide: AnthropicProvider, useValue: new FakeProvider() }
  : AnthropicProvider;
const openAiEmbeddingProviderDefinition = process.env.VITEST
  ? { provide: OpenAiEmbeddingProvider, useValue: new FakeEmbeddingProvider() }
  : OpenAiEmbeddingProvider;

// Global for the same reason as ConfigModule/DbModule — a cross-cutting
// layer every domain module will consume.
@Global()
@Module({
  providers: [anthropicProviderDefinition, LlmService, openAiEmbeddingProviderDefinition, EmbeddingService],
  exports: [LlmService, EmbeddingService],
})
export class LlmModule implements OnModuleInit {
  onModuleInit(): void {
    // Prompt prose ships as a build asset; if it didn't make it into the
    // image, fail here rather than on the first user action.
    assertTemplateTextAvailable();
  }
}
