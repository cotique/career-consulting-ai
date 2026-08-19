import { Global, Module, type OnModuleInit } from '@nestjs/common';
import { AnthropicProvider } from './providers/anthropic.provider';
import { LlmService } from './llm.service';
import { assertTemplateTextAvailable } from './templates';

// Global for the same reason as ConfigModule/DbModule — a cross-cutting
// layer every domain module will consume.
@Global()
@Module({
  providers: [AnthropicProvider, LlmService],
  exports: [LlmService],
})
export class LlmModule implements OnModuleInit {
  onModuleInit(): void {
    // Prompt prose ships as a build asset; if it didn't make it into the
    // image, fail here rather than on the first user action.
    assertTemplateTextAvailable();
  }
}
