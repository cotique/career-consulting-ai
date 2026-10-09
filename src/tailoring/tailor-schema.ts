import { z } from 'zod';

/**
 * What `resume_tailor` promises: a plan, never a resume. Every field here is an
 * index or a short replacement bullet — there is deliberately no place in this
 * shape for a company, a date, a title or a new skill, so a model that tries to
 * volunteer one has it stripped by the parser rather than caught by a check.
 *
 * Unknown keys are stripped rather than rejected, same trade as the other
 * schemas: an extra field is not worth a paid retry. Whether the *values* are
 * usable (a real permutation, indices in range) is `applyTailoringPlan`'s job,
 * because that needs the resume this plan is about.
 */
const index = z.number().int().min(0);

export const TailoringPlanSchema = z.object({
  highlightOrder: z.array(z.object({ experienceIndex: index, order: z.array(index) })).default([]),
  skillsOrder: z.array(index).default([]),
  keywordEdits: z
    .array(
      z.object({
        experienceIndex: index,
        highlightIndex: index,
        // Trimmed before the length check, so whitespace cannot pass for content.
        text: z.string().trim().min(1),
        keywords: z.array(z.string().trim().min(1)).min(1),
      }),
    )
    .default([]),
});

export type TailoringPlan = z.infer<typeof TailoringPlanSchema>;
