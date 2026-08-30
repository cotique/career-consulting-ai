import { z } from 'zod';

/**
 * The shape `vacancy_parse` promises. Unknown keys are stripped rather than
 * rejected — the same trade as the resume schema: a model volunteering an extra
 * field is not worth a paid retry, while a wrong *type* is, because that is
 * what corrupts everything downstream that reads this structure.
 */

const compensation = z.object({
  min: z.number().nullish(),
  max: z.number().nullish(),
  currency: z.string().nullish(),
  period: z.enum(['hour', 'day', 'month', 'year']).nullish(),
  // The sentence as written. Kept because every normalised field above is a
  // reading of it, and a reading that turns out wrong is only checkable against
  // the original.
  raw: z.string().nullish(),
});

/**
 * Whether the posting is published by someone hiring on another company's
 * behalf, and who that company is.
 *
 * `isIntermediary` is nullable *and* the prompt is told null is usually right,
 * because the useful output here is a checkable hypothesis rather than a
 * verdict: being submitted through an agency commonly forecloses applying
 * directly, so a confident wrong answer costs the reader the application.
 *
 * Each half carries the quoted words it rests on. Evidence is what makes the
 * claim checkable in a second; without it the field is an opinion with a
 * boolean's authority.
 */
const intermediary = z.object({
  isIntermediary: z.boolean().nullish(),
  evidence: z.string().nullish(),
  endClient: z.string().nullish(),
  endClientEvidence: z.string().nullish(),
});

export const VacancyStructureSchema = z.object({
  title: z.string().nullish(),
  companyName: z.string().nullish(),
  // ISO 3166-1 alpha-2, or null when the posting does not say. Validated
  // loosely: a model returning "Poland" here is wrong but not worth a paid
  // retry, and `countryCodeOf` below refuses anything that is not two letters.
  countryCode: z.string().nullish(),
  location: z.string().nullish(),
  workMode: z.enum(['remote', 'hybrid', 'onsite']).nullish(),
  employmentType: z.string().nullish(),
  seniority: z.string().nullish(),
  requirements: z.array(z.string()).default([]),
  responsibilities: z.array(z.string()).default([]),
  languages: z.array(z.object({ language: z.string(), level: z.string().nullish() })).default([]),
  compensation: compensation.nullish(),
  intermediary: intermediary.default({}),
});

export type VacancyStructure = z.infer<typeof VacancyStructureSchema>;

/**
 * Whether the model actually read the posting.
 *
 * Every field above is optional or defaulted, so `{}` is a *valid*
 * `VacancyStructure` — a job with no title, at no company, asking for nothing.
 * Storing that would present "the model told us nothing" as a parsed vacancy,
 * and scoring would then run against an empty description and produce a number.
 *
 * The intermediary block is excluded from the test on purpose: an answer that
 * found only "this looks like an agency" has not read the posting, and counting
 * it would let the emptiest possible parse through under an honest label.
 */
export function hasParsedSubstance(structure: VacancyStructure): boolean {
  return Boolean(
    structure.title?.trim() ||
      structure.companyName?.trim() ||
      structure.requirements.length ||
      structure.responsibilities.length,
  );
}

/**
 * The country code in the form the `vacancies.country_code` column promises,
 * or null. Anything that is not two letters is dropped rather than stored:
 * market behaviour keys off this column, and a "Poland" sitting where "PL" is
 * expected fails no constraint and matches no list — it just quietly stops
 * being European.
 */
export function countryCodeOf(structure: VacancyStructure): string | null {
  const code = structure.countryCode?.trim().toUpperCase();
  return code && /^[A-Z]{2}$/.test(code) ? code : null;
}
