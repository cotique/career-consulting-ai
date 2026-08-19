import { loadTemplateText } from './load-text';
import type { PromptTemplate, TemplateParams } from './template.types';
import { renderParams } from './template.types';

export const RESUME_TEXT = 'resume';

const TEXT_FILE = 'resume-extract.md';

export const resumeExtract: PromptTemplate = {
  name: 'resume_extract',
  version: 'resume-extract-v1',
  taskType: 'resume_extraction',
  textFile: TEXT_FILE,
  untrusted: [RESUME_TEXT],
  // A resume is the largest document in the system and everything downstream
  // reads this output, so the bound is generous — truncating an extraction
  // silently loses the last job on someone's CV.
  maxTokens: 8192,
  build: (params: TemplateParams): string => loadTemplateText(TEXT_FILE) + renderParams(params),
};
