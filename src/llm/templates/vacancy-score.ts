import { loadTemplateText } from './load-text';
import type { PromptTemplate, TemplateParams } from './template.types';
import { renderParams } from './template.types';

export const VACANCY_SCORE_PROFILE = 'profile';
export const VACANCY_SCORE_RESUME = 'resume_extraction';
export const VACANCY_SCORE_VACANCY = 'vacancy_structure';

const TEXT_FILE = 'vacancy-score.md';

export const vacancyScore: PromptTemplate = {
  name: 'vacancy_score',
  version: 'vacancy-score-v1',
  taskType: 'vacancy_scoring',
  textFile: TEXT_FILE,
  untrusted: [VACANCY_SCORE_PROFILE, VACANCY_SCORE_RESUME, VACANCY_SCORE_VACANCY],
  // Three already-structured documents rather than one long free-text one —
  // similar order to vacancy_parse, since the output is comparably short
  // (a score plus two short lists).
  maxTokens: 4096,
  build: (params: TemplateParams): string => loadTemplateText(TEXT_FILE) + renderParams(params),
};
