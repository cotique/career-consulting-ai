import { z } from 'zod';

/**
 * The shape `vacancy_score` promises. Unknown keys are stripped rather than
 * rejected — same trade as the parse/extraction schemas: a model volunteering
 * an extra field is not worth a paid retry, while a wrong type is, since that
 * is what corrupts everything downstream that reads this structure.
 *
 * `score` is bounded 0–1 by the schema itself, so an out-of-range value fails
 * validation and goes through the layer's existing one-retry-then-fail path
 * rather than ever reaching storage.
 */
export const VacancyScoreSchema = z.object({
  score: z.number().min(0).max(1),
  presentable: z.array(z.string()).default([]),
  tradeoff: z
    .object({
      fits: z.array(z.string()).default([]),
      doesNotFit: z.array(z.string()).default([]),
    })
    .default({ fits: [], doesNotFit: [] }),
});

export type VacancyScoreOutput = z.infer<typeof VacancyScoreSchema>;
