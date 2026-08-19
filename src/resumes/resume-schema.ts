import { z } from 'zod';
import { CONTACTS_FIELD } from '../llm/scrub';

/**
 * The shape the extraction template promises. Unknown keys are stripped rather
 * than rejected: a model volunteering an extra field is not worth a paid retry,
 * while a wrong *type* is, since that is what would corrupt everything
 * downstream that reads this structure.
 *
 * All contact details live in one object, named to match `CONTACTS_FIELD`, so
 * `stripContacts` removes them wholesale before this structure is fed into any
 * later prompt. That naming is load-bearing, hence the assertion below rather
 * than a comment asking the next person to remember.
 */
const contacts = z.object({
  email: z.string().nullish(),
  phone: z.string().nullish(),
  links: z.array(z.string()).default([]),
});

export const ResumeStructureSchema = z.object({
  [CONTACTS_FIELD]: contacts.default({ links: [] }),
  name: z.string().nullish(),
  headline: z.string().nullish(),
  summary: z.string().nullish(),
  experience: z
    .array(
      z.object({
        company: z.string().nullish(),
        title: z.string().nullish(),
        start: z.string().nullish(),
        // null means "current role" — the template says so explicitly, because
        // a model left to itself invents an end date.
        end: z.string().nullish(),
        location: z.string().nullish(),
        highlights: z.array(z.string()).default([]),
      }),
    )
    .default([]),
  education: z
    .array(
      z.object({
        institution: z.string().nullish(),
        qualification: z.string().nullish(),
        start: z.string().nullish(),
        end: z.string().nullish(),
      }),
    )
    .default([]),
  skills: z.array(z.string()).default([]),
  languages: z
    .array(z.object({ language: z.string(), level: z.string().nullish() }))
    .default([]),
});

export type ResumeStructure = z.infer<typeof ResumeStructureSchema>;

/**
 * Whether the model actually told us anything about this person.
 *
 * Necessary because every field above is optional or defaulted, so `{}` is a
 * *valid* `ResumeStructure` — one describing someone with no name, no history
 * and no skills. Validity is the wrong question there: the schema's leniency is
 * deliberate (a wrong type is worth a retry, a missing field is not), and the
 * cost of that leniency is that "the model produced nothing" and "this person
 * has nothing" become the same value.
 *
 * Contact details are excluded from the test on purpose. An extraction that
 * found only an email address has still failed to read the resume, and counting
 * it as success would store an empty career under an honest-looking label.
 */
export function hasExtractedSubstance(structure: ResumeStructure): boolean {
  return Boolean(
    structure.name?.trim() ||
      structure.headline?.trim() ||
      structure.summary?.trim() ||
      structure.experience.length ||
      structure.education.length ||
      structure.skills.length,
  );
}

// If the contacts key is ever renamed on one side only, scrubbing silently
// stops working and PII starts travelling into prompts. Fail at import time
// instead.
if (!(CONTACTS_FIELD in ResumeStructureSchema.shape)) {
  throw new Error(
    `ResumeStructureSchema must carry contact details under "${CONTACTS_FIELD}" so stripContacts can remove them.`,
  );
}
