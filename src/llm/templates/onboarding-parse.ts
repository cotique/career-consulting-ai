import { loadTemplateText } from './load-text';
import type { PromptTemplate, TemplateParams } from './template.types';
import { renderParams } from './template.types';

export const ONBOARDING_FREE_TEXT = 'what the user wrote';

const TEXT_FILE = 'onboarding-parse.md';

export const onboardingParse: PromptTemplate = {
  name: 'onboarding_parse',
  version: 'onboarding-parse-v1',
  taskType: 'onboarding_parsing',
  textFile: TEXT_FILE,
  untrusted: [ONBOARDING_FREE_TEXT],
  maxTokens: 1024,
  // Closes over the file name rather than reading `this.textFile`, so the
  // method survives being passed around detached from its object.
  build: (params: TemplateParams): string => loadTemplateText(TEXT_FILE) + renderParams(params),
};
