import { loadTemplateText } from './load-text';
import type { PromptTemplate, TemplateParams } from './template.types';
import { renderParams } from './template.types';

export const RESUME_TAILOR_RESUME = 'indexed_resume';
export const RESUME_TAILOR_VACANCY = 'vacancy_structure';

const TEXT_FILE = 'resume-tailor.md';

export const resumeTailor: PromptTemplate = {
  name: 'resume_tailor',
  version: 'resume-tailor-v1',
  taskType: 'tailoring',
  textFile: TEXT_FILE,
  untrusted: [RESUME_TAILOR_RESUME, RESUME_TAILOR_VACANCY],
  // A plan of indices plus a handful of reworded bullets, not a resume — the
  // output is a fraction of the input.
  maxTokens: 4096,
  build: (params: TemplateParams): string => loadTemplateText(TEXT_FILE) + renderParams(params),
};
