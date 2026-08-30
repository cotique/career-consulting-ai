import { loadTemplateText } from './load-text';
import type { PromptTemplate, TemplateParams } from './template.types';
import { renderParams } from './template.types';

export const VACANCY_TEXT = 'vacancy';

const TEXT_FILE = 'vacancy-parse.md';

export const vacancyParse: PromptTemplate = {
  name: 'vacancy_parse',
  version: 'vacancy-parse-v1',
  taskType: 'vacancy_parsing',
  textFile: TEXT_FILE,
  untrusted: [VACANCY_TEXT],
  // Half the resume bound. A posting is a fraction of a CV's length and the
  // output is mostly short lists — but a long agency posting with fifteen
  // requirements still has to fit, and a truncated parse is not retried.
  maxTokens: 4096,
  build: (params: TemplateParams): string => loadTemplateText(TEXT_FILE) + renderParams(params),
};
