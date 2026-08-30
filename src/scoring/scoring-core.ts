import { blockersFor, type VacancyBlocker } from '../intake/market-scope';
import type { VacancyStructure } from '../intake/vacancy-schema';
import type { LlmService } from '../llm/llm.service';
import { VACANCY_SCORE_PROFILE, VACANCY_SCORE_RESUME, VACANCY_SCORE_VACANCY } from '../llm/templates';
import type { ResumeStructure } from '../resumes/resume-schema';
import { VacancyScoreSchema } from './score-schema';

/** The scoring-relevant slice of `user_profiles` — timezone/notification settings don't belong in a prompt. */
export interface ScoreProfile {
  targetRoles: string[] | null;
  locations: string[] | null;
  preferences: unknown;
  targetMarkets: unknown;
}

export interface ScoreVacancy {
  structured: VacancyStructure;
  countryCode: string | null;
}

export interface ScoreInputs {
  userId: string;
  profile: ScoreProfile;
  extraction: ResumeStructure;
  vacancy: ScoreVacancy;
}

export interface ScoreResult {
  score: number;
  showable: string[];
  tradeoff: { fits: string[]; doesNotFit: string[] };
  blockers: VacancyBlocker[];
  promptVersion: string;
  modelUsed: string;
}

/**
 * The scoring core (T17 design hook): a function over supplied inputs rather
 * than ids. Auth stays at the guard layer — the service loads `profile`,
 * `extraction` and `vacancy` and calls this; a future anonymous path could
 * supply a profile from the request body instead, without this function or
 * its caller changing. `userId` is the one exception, carried through only
 * for LLM usage accounting (NFR1) — it is not used to look anything up here.
 *
 * `blockers` is the existing market-scope blocker (NFR15), not a new kind:
 * scoring re-surfaces it rather than inventing a citizenship/language
 * detector, which nothing in T17's verification exercises.
 */
export async function scoreAgainstProfile(
  llm: LlmService,
  inputs: ScoreInputs,
): Promise<ScoreResult> {
  const blockers = blockersFor(inputs.vacancy.countryCode);

  const { data, promptVersion, model } = await llm.completeStructured(
    {
      template: 'vacancy_score',
      userId: inputs.userId,
      // Profile and resume are the user's own data, and the vacancy is a
      // posting from outside the system — all three are untrusted the same
      // way: the rendering layer wraps them in data delimiters. Contact
      // fields in `extraction` are stripped automatically by the layer.
      untrusted: {
        [VACANCY_SCORE_PROFILE]: inputs.profile,
        [VACANCY_SCORE_RESUME]: inputs.extraction,
        [VACANCY_SCORE_VACANCY]: inputs.vacancy.structured,
      },
    },
    VacancyScoreSchema,
  );

  return {
    score: data.score,
    showable: data.presentable,
    tradeoff: data.tradeoff,
    blockers,
    promptVersion,
    modelUsed: model,
  };
}

/**
 * Whether there is enough to score against, and what is missing if not.
 * Unit-testable in isolation: an empty profile or a resume that was never
 * extracted must be a distinguishable "missing" condition the caller can act
 * on (409, per NFR2 — zero provider calls), not a silent score of zero
 * against nothing.
 */
export function missingScoringInput(
  profile: unknown,
  extraction: unknown,
): 'missing_profile' | 'missing_resume' | null {
  if (!profile) return 'missing_profile';
  if (!extraction) return 'missing_resume';
  return null;
}
