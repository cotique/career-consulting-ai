import { loadTemplateText } from './load-text';
import { onboardingParse } from './onboarding-parse';
import { resumeExtract } from './resume-extract';
import type { PromptTemplate } from './template.types';

/**
 * The prompt template registry (retro-audit 3.4).
 *
 * Every LLM call names a template here; there is no path for a caller to pass
 * free-form instructions. Two things follow from that: `promptVersion` is
 * registry-derived rather than caller-invented (so it can't drift from the
 * prompt it labels), and every prompt in the system is readable in one place
 * instead of scattered across service files.
 *
 * Templates are added here as their features land — this registry deliberately
 * holds only prompts that have a consumer, not speculative ones for Epics that
 * haven't been built.
 */
export const TEMPLATES = {
  onboarding_parse: onboardingParse,
  resume_extract: resumeExtract,
} as const satisfies Record<string, PromptTemplate>;

export type TemplateName = keyof typeof TEMPLATES;

export function getTemplate(name: TemplateName): PromptTemplate {
  const template = TEMPLATES[name];
  if (!template) {
    throw new Error(`Unknown prompt template "${String(name)}".`);
  }
  return template;
}

/**
 * Loads every template's prose once, at boot. Instruction text is shipped as
 * a build asset (nest-cli.json), so it can go missing in a way TypeScript
 * can't catch — a container built without it would start up healthy and fail
 * on the first user action. This turns that into a failed boot instead.
 */
export function assertTemplateTextAvailable(): void {
  for (const template of Object.values(TEMPLATES)) {
    loadTemplateText(template.textFile);
  }
}

export type { PromptTemplate, TemplateParams } from './template.types';
export { ONBOARDING_FREE_TEXT } from './onboarding-parse';
export { RESUME_TEXT } from './resume-extract';
