import type { ProviderName, TaskType } from './types';

export interface TaskModelConfig {
  provider: ProviderName;
  model: string;
}

/**
 * The single place to change which model serves which task (NFR11).
 *
 * **Everything is on Haiku 4.5 today** because no task has a consumer yet — routing a
 * task to a dearer model before anything calls it would be paying for quality
 * nobody can observe. That is a starting point, not the intended end state:
 * per-task model choice is the reason this table exists.
 *
 * What each task will actually need, decided now rather than discovered when
 * the output disappoints. Reassess each one when its epic lands — the *volume*
 * numbers matter as much as the difficulty, because they multiply.
 *
 * | Task                | Needs        | Volume        | Why |
 * |---------------------|--------------|---------------|-----|
 * | `vacancy_parsing`   | cheap + fast | high (batches)| Mechanical extraction from text into a known shape. The cheapest model that holds the schema wins; every vacancy in a sourcing run pays this. |
 * | `vacancy_scoring`   | mid, cheap-leaning | high    | Real judgment (fit against a profile), but a wrong score costs attention, not a bad deliverable — and it runs on every vacancy. Escalate only if scores prove untrustworthy in dogfooding. |
 * | `resume_extraction` | accurate; cost secondary | very low (once per resume) | Everything downstream derives from this — a misread of the resume propagates into every score and every tailored document. Low volume makes a strong model nearly free here. |
 * | `tailoring`         | expensive, best available | low-mid | The output *is* the product: text a human sends to an employer. Writing quality is the whole point, and this is the last place to economise. |
 * | `onboarding_parsing`| cheap + fast | very low (once) | Low stakes: the user reviews and confirms the result before it is stored, so a miss is visible and correctable rather than silent. |
 *
 * Fast matters where a person is waiting (onboarding, anything synchronous);
 * it matters much less inside a batch job nobody watches.
 */
export const TASK_MODELS: Record<TaskType, TaskModelConfig> = {
  vacancy_parsing: { provider: 'anthropic', model: 'claude-haiku-4-5' },
  vacancy_scoring: { provider: 'anthropic', model: 'claude-haiku-4-5' },
  resume_extraction: { provider: 'anthropic', model: 'claude-haiku-4-5' },
  tailoring: { provider: 'anthropic', model: 'claude-haiku-4-5' },
  onboarding_parsing: { provider: 'anthropic', model: 'claude-haiku-4-5' },
};
