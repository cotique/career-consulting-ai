import { describe, expect, it } from 'vitest';
import type { VacancyStructure } from '../intake/vacancy-schema';
import type { ResumeStructure } from '../resumes/resume-schema';
import { applyTailoringPlan, indexedResumeForPrompt, TailoringPlanError } from './apply-plan';
import { TailoringPlanSchema, type TailoringPlan } from './tailor-schema';

/**
 * The part of tailoring that can be proven without a model: given any plan a
 * model might return, what the code is willing to turn into a resume. The
 * prompt's quality is judged by reading real output; this is about what the
 * code lets through whatever the prompt does.
 */
const SOURCE: ResumeStructure = {
  contacts: { email: 'candidate@example.com', phone: '+48 600 100 200', links: ['https://example.com/in/c'] },
  name: 'Candidate',
  headline: 'Backend Engineer',
  summary: 'Builds payment systems.',
  experience: [
    {
      company: 'Prior Co',
      title: 'Senior Engineer',
      start: '2019-03',
      end: null,
      location: 'Wroclaw',
      highlights: ['Ran the deploy pipeline for 12 services', 'Mentored 3 engineers', 'Cut cloud spend by 30%'],
    },
    {
      company: 'Older Co',
      title: 'Engineer',
      start: '2015-01',
      end: '2019-02',
      location: null,
      highlights: ['Built internal dashboards'],
    },
  ],
  education: [{ institution: 'Politechnika', qualification: 'MSc', start: '2010', end: '2015' }],
  skills: ['TypeScript', 'Postgres', 'Docker'],
  languages: [{ language: 'English', level: 'C1' }],
};

const VACANCY: VacancyStructure = {
  title: 'Backend Engineer',
  companyName: 'Acme',
  countryCode: 'PL',
  location: 'Warsaw',
  workMode: 'hybrid',
  employmentType: 'full-time',
  seniority: null,
  requirements: ['CI/CD pipeline experience', 'Mentoring engineers'],
  responsibilities: ['Own the payments service'],
  languages: [],
  compensation: null,
  intermediary: { isIntermediary: null, evidence: null, endClient: null, endClientEvidence: null },
};

const EMPTY_PLAN: TailoringPlan = { highlightOrder: [], skillsOrder: [], keywordEdits: [] };

function plan(overrides: Partial<TailoringPlan>): TailoringPlan {
  return { ...EMPTY_PLAN, ...overrides };
}

/** Everything a plan must never be able to move: the resume without its bullets and skill order. */
function protectedPart(resume: ResumeStructure) {
  return {
    ...resume,
    skills: [...resume.skills].sort(),
    experience: resume.experience.map((role) => ({ ...role, highlights: [] })),
  };
}

const goodEdit = {
  experienceIndex: 0,
  highlightIndex: 0,
  text: 'Ran the CI/CD pipeline for 12 services',
  keywords: ['CI/CD'],
};

describe('applyTailoringPlan', () => {
  it('returns the resume unchanged for an empty plan', () => {
    const { structure, changes } = applyTailoringPlan(SOURCE, VACANCY, EMPTY_PLAN);

    expect(structure).toEqual(SOURCE);
    expect(changes).toEqual({ highlightsReordered: [], skillsReordered: null, edits: [], rejectedEdits: [] });
  });

  it('reorders bullets and skills and does not mutate the source', () => {
    const before = structuredClone(SOURCE);

    const { structure, changes } = applyTailoringPlan(
      SOURCE,
      VACANCY,
      plan({ highlightOrder: [{ experienceIndex: 0, order: [1, 2, 0] }], skillsOrder: [2, 0, 1] }),
    );

    expect(structure.experience[0].highlights).toEqual([
      'Mentored 3 engineers',
      'Cut cloud spend by 30%',
      'Ran the deploy pipeline for 12 services',
    ]);
    expect(structure.skills).toEqual(['Docker', 'TypeScript', 'Postgres']);
    expect(changes.highlightsReordered).toEqual([{ experienceIndex: 0, order: [1, 2, 0] }]);
    expect(changes.skillsReordered).toEqual([2, 0, 1]);
    expect(SOURCE).toEqual(before);
  });

  it('does not report an identity order as a change', () => {
    const { changes } = applyTailoringPlan(
      SOURCE,
      VACANCY,
      plan({ highlightOrder: [{ experienceIndex: 0, order: [0, 1, 2] }], skillsOrder: [0, 1, 2] }),
    );

    expect(changes.highlightsReordered).toEqual([]);
    expect(changes.skillsReordered).toBeNull();
  });

  it('applies a supported keyword edit and reports before and after', () => {
    const { structure, changes } = applyTailoringPlan(SOURCE, VACANCY, plan({ keywordEdits: [goodEdit] }));

    expect(structure.experience[0].highlights[0]).toBe('Ran the CI/CD pipeline for 12 services');
    expect(changes.edits).toEqual([
      {
        experienceIndex: 0,
        highlightIndex: 0,
        before: 'Ran the deploy pipeline for 12 services',
        after: 'Ran the CI/CD pipeline for 12 services',
        keywords: ['CI/CD'],
      },
    ]);
    expect(changes.rejectedEdits).toEqual([]);
  });

  it('reads edit indices against the original, so an edit follows its bullet through a reorder', () => {
    const { structure } = applyTailoringPlan(
      SOURCE,
      VACANCY,
      plan({
        keywordEdits: [goodEdit],
        highlightOrder: [{ experienceIndex: 0, order: [1, 2, 0] }],
      }),
    );

    expect(structure.experience[0].highlights[2]).toBe('Ran the CI/CD pipeline for 12 services');
  });

  it('leaves every protected field byte-identical whatever the plan does', () => {
    const { structure } = applyTailoringPlan(
      SOURCE,
      VACANCY,
      plan({
        keywordEdits: [goodEdit],
        highlightOrder: [
          { experienceIndex: 0, order: [2, 1, 0] },
          { experienceIndex: 1, order: [0] },
        ],
        skillsOrder: [1, 2, 0],
      }),
    );

    expect(JSON.stringify(protectedPart(structure))).toBe(JSON.stringify(protectedPart(SOURCE)));
    expect(structure.experience.map((role) => role.company)).toEqual(['Prior Co', 'Older Co']);
  });

  describe('drops an edit that cannot be vouched for, and says why', () => {
    const cases: Array<[string, TailoringPlan['keywordEdits'][number], RegExp]> = [
      ['a keyword that is not in the posting', { ...goodEdit, keywords: ['Kubernetes'] }, /not in the posting/],
      [
        'a keyword claimed but absent from the new wording',
        { ...goodEdit, text: 'Ran the deploy pipeline for 12 services' , keywords: ['CI/CD'] },
        /absent from the new wording/,
      ],
      [
        'a changed number',
        { ...goodEdit, text: 'Ran the CI/CD pipeline for 15 services' },
        /numbers/,
      ],
      [
        'a dropped number',
        { ...goodEdit, text: 'Ran the CI/CD pipeline for services' },
        /numbers/,
      ],
      [
        'a word found in neither the resume nor the posting',
        { ...goodEdit, text: 'Ran the CI/CD pipeline for 12 services on Kubernetes' },
        /neither in the resume nor claimed.*kubernetes/,
      ],
      [
        'a word from the posting that the edit uses without claiming it as a keyword',
        { ...goodEdit, text: 'Ran the CI/CD pipeline for 12 services with payments' },
        /neither in the resume nor claimed.*payments/,
      ],
      [
        'a line break that would render as a heading of its own',
        { ...goodEdit, text: 'Ran the CI/CD pipeline for 12 services\n### Senior Engineer' },
        /line break/,
      ],
      [
        'a bullet cut down to a fragment',
        { ...goodEdit, text: 'CI/CD 12' },
        /shorter/,
      ],
      [
        'a bullet much longer than the original',
        { ...goodEdit, text: `Ran the CI/CD pipeline for 12 services ${'the pipeline '.repeat(12)}` },
        /longer/,
      ],
    ];

    it.each(cases)('%s', (_name, edit, reason) => {
      const { structure, changes } = applyTailoringPlan(SOURCE, VACANCY, plan({ keywordEdits: [edit] }));

      expect(structure.experience[0].highlights[0]).toBe('Ran the deploy pipeline for 12 services');
      expect(changes.edits).toEqual([]);
      expect(changes.rejectedEdits).toHaveLength(1);
      expect(changes.rejectedEdits[0].reason).toMatch(reason);
    });

    it('a second edit to the same bullet', () => {
      const { changes } = applyTailoringPlan(SOURCE, VACANCY, plan({ keywordEdits: [goodEdit, goodEdit] }));

      expect(changes.edits).toHaveLength(1);
      expect(changes.rejectedEdits[0].reason).toMatch(/twice/);
    });

    it('judges a corrected edit on its own after a refused attempt at the same bullet', () => {
      const { changes } = applyTailoringPlan(
        SOURCE,
        VACANCY,
        plan({ keywordEdits: [{ ...goodEdit, keywords: ['Kubernetes'] }, goodEdit] }),
      );

      expect(changes.rejectedEdits).toHaveLength(1);
      expect(changes.rejectedEdits[0].reason).toMatch(/not in the posting/);
      expect(changes.edits).toHaveLength(1);
    });

    it('keeps the good edits when one in the same plan is refused', () => {
      const { structure, changes } = applyTailoringPlan(
        SOURCE,
        VACANCY,
        plan({
          keywordEdits: [
            { ...goodEdit, keywords: ['Kubernetes'] },
            { experienceIndex: 0, highlightIndex: 1, text: 'Mentoring 3 engineers', keywords: ['Mentoring'] },
          ],
        }),
      );

      expect(changes.rejectedEdits).toHaveLength(1);
      expect(changes.edits).toHaveLength(1);
      expect(structure.experience[0].highlights[0]).toBe('Ran the deploy pipeline for 12 services');
      expect(structure.experience[0].highlights[1]).toBe('Mentoring 3 engineers');
    });
  });

  describe('refuses a plan that misreads the resume', () => {
    const bad: Array<[string, Partial<TailoringPlan>]> = [
      ['a bullet order with a repeated index', { highlightOrder: [{ experienceIndex: 0, order: [0, 0, 1] }] }],
      ['a bullet order that is too short', { highlightOrder: [{ experienceIndex: 0, order: [1, 0] }] }],
      ['a bullet order with an index out of range', { highlightOrder: [{ experienceIndex: 0, order: [0, 1, 3] }] }],
      ['an order for a role that does not exist', { highlightOrder: [{ experienceIndex: 5, order: [0] }] }],
      [
        'two orders for one role',
        {
          highlightOrder: [
            { experienceIndex: 1, order: [0] },
            { experienceIndex: 1, order: [0] },
          ],
        },
      ],
      ['a skills order that drops a skill', { skillsOrder: [0, 1] }],
      ['a skills order that invents a skill', { skillsOrder: [0, 1, 2, 3] }],
      ['an edit to a bullet that does not exist', { keywordEdits: [{ ...goodEdit, highlightIndex: 9 }] }],
      ['an edit to a role that does not exist', { keywordEdits: [{ ...goodEdit, experienceIndex: 4 }] }],
    ];

    it.each(bad)('%s', (_name, overrides) => {
      expect(() => applyTailoringPlan(SOURCE, VACANCY, plan(overrides))).toThrow(TailoringPlanError);
    });
  });
});

describe('indexedResumeForPrompt', () => {
  it('numbers every role, bullet and skill and carries no contact details', () => {
    const indexed = indexedResumeForPrompt(SOURCE);

    expect(indexed.experience[1]).toEqual({
      index: 1,
      company: 'Older Co',
      title: 'Engineer',
      highlights: [{ index: 0, text: 'Built internal dashboards' }],
    });
    expect(indexed.skills).toEqual([
      { index: 0, name: 'TypeScript' },
      { index: 1, name: 'Postgres' },
      { index: 2, name: 'Docker' },
    ]);
    const text = JSON.stringify(indexed);
    expect(text).not.toContain('candidate@example.com');
    expect(text).not.toContain('600 100 200');
    expect(text).not.toContain('example.com/in');
  });
});

describe('TailoringPlanSchema', () => {
  it('strips fields the plan has no place for rather than passing them on', () => {
    const parsed = TailoringPlanSchema.parse({
      highlightOrder: [],
      experience: [{ company: 'Google' }],
      skills: ['Rust'],
      name: 'Someone Else',
    });

    expect(Object.keys(parsed).sort()).toEqual(['highlightOrder', 'keywordEdits', 'skillsOrder']);
  });

  it('refuses an edit whose text or keyword is only whitespace', () => {
    const edit = { experienceIndex: 0, highlightIndex: 0, text: 'Ran the CI/CD pipeline', keywords: ['CI/CD'] };

    expect(TailoringPlanSchema.safeParse({ keywordEdits: [{ ...edit, text: '   ' }] }).success).toBe(false);
    expect(TailoringPlanSchema.safeParse({ keywordEdits: [{ ...edit, keywords: [' '] }] }).success).toBe(false);
    expect(TailoringPlanSchema.safeParse({ keywordEdits: [edit] }).success).toBe(true);
  });
});
