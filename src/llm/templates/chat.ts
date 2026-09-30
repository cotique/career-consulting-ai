import { loadTemplateText } from './load-text';
import type { PromptTemplate, TemplateParams } from './template.types';
import { renderParams } from './template.types';

export const CHAT_RETRIEVED_CONTEXT = 'retrieved_context';
export const CHAT_HISTORY = 'conversation_history';
export const CHAT_MESSAGE = 'user_message';

const TEXT_FILE = 'chat.md';

export const chat: PromptTemplate = {
  name: 'chat',
  version: 'chat-v1',
  taskType: 'chat',
  textFile: TEXT_FILE,
  untrusted: [CHAT_RETRIEVED_CONTEXT, CHAT_HISTORY, CHAT_MESSAGE],
  // A conversational answer, not a data extraction — room for a real paragraph
  // or two, well short of vacancy_score's ceiling since there's no multi-field
  // JSON structure to fit.
  maxTokens: 1024,
  build: (params: TemplateParams): string => loadTemplateText(TEXT_FILE) + renderParams(params),
};
