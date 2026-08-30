import { isEuropeanCountryCode } from '../onboarding/markets';

/**
 * A reason a vacancy is out of reach, as opposed to merely a poor fit.
 *
 * The distinction is the load-bearing one of this epic. A **blocker** is about
 * possibility — a market outside the supported scope, a requirement that cannot
 * be met — and seeing the vacancy does not change it. A **minus** is about
 * preference — pay, format, stack — and preference is revised by seeing the
 * thing, which is why the thing has to be shown.
 *
 * Blocked is not deleted. The row is written, the reason is readable, and
 * `GET /me/vacancies?all=true` returns it. That is not caution for its own
 * sake: this classification is itself fallible, and a filter no one can inspect
 * is a filter no one can correct.
 */
export interface VacancyBlocker {
  kind: 'outside_supported_markets';
  reason: string;
}

/**
 * The only blocker kind that exists (NFR15). Scoring (T17) re-surfaces this
 * same computation rather than adding a second blocker vocabulary — nothing
 * yet needs a blocker that only scoring, not intake, could know about.
 *
 * An unknown country is deliberately not a blocker: the posting not saying
 * where the work is, and the work being somewhere unsupported, are different
 * facts, and treating them alike would hide vacancies for the sin of being
 * vague.
 */
export function blockersFor(countryCode: string | null): VacancyBlocker[] {
  if (!countryCode || isEuropeanCountryCode(countryCode)) return [];
  return [
    {
      kind: 'outside_supported_markets',
      reason: `This role is based in ${countryCode}, outside the European markets supported at launch. It is stored and readable — it is only kept out of the default list.`,
    },
  ];
}
