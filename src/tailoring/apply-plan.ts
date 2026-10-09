import type { VacancyStructure } from '../intake/vacancy-schema';
import type { ResumeStructure } from '../resumes/resume-schema';
import type { TailoringPlan } from './tailor-schema';

/** The plan cannot be applied at all — not a permutation, or points outside the resume. */
export class TailoringPlanError extends Error {}

export interface TailoringChanges {
  highlightsReordered: Array<{ experienceIndex: number; order: number[] }>;
  skillsReordered: number[] | null;
  edits: Array<{
    experienceIndex: number;
    highlightIndex: number;
    before: string;
    after: string;
    keywords: string[];
  }>;
  /** Edits that were proposed and not applied, with why — shown so the user can see what was refused. */
  rejectedEdits: Array<{ experienceIndex: number; highlightIndex: number; reason: string }>;
}

export interface TailoredResult {
  structure: ResumeStructure;
  changes: TailoringChanges;
}

/**
 * The resume as the model sees it: every role, bullet and skill carries the
 * index the plan will refer back to. Models count positions in a JSON array
 * badly, so the indices are written out rather than left implicit. Contact
 * details are not included at all.
 */
export function indexedResumeForPrompt(source: ResumeStructure) {
  return {
    headline: source.headline ?? null,
    summary: source.summary ?? null,
    experience: source.experience.map((role, index) => ({
      index,
      company: role.company ?? null,
      title: role.title ?? null,
      highlights: role.highlights.map((text, i) => ({ index: i, text })),
    })),
    skills: source.skills.map((name, index) => ({ index, name })),
  };
}

function isPermutation(order: number[], length: number): boolean {
  if (order.length !== length) return false;
  const seen = new Set<number>();
  for (const i of order) {
    if (!Number.isInteger(i) || i < 0 || i >= length || seen.has(i)) return false;
    seen.add(i);
  }
  return true;
}

const isIdentity = (order: number[]): boolean => order.every((value, i) => value === i);

function tokens(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+(?:[+#]+)?/gu) ?? [];
}

function numbers(text: string): string[] {
  return (text.match(/\d+(?:[.,]\d+)?/g) ?? []).sort();
}

function resumeText(source: ResumeStructure): string {
  return [
    source.headline,
    source.summary,
    ...source.skills,
    ...source.experience.flatMap((role) => [role.company, role.title, ...role.highlights]),
  ]
    .filter((part): part is string => Boolean(part))
    .join('\n');
}

function vacancyText(vacancy: VacancyStructure): string {
  return [vacancy.title, ...vacancy.requirements, ...vacancy.responsibilities]
    .filter((part): part is string => Boolean(part))
    .join('\n');
}

const MAX_GROWTH_FACTOR = 1.5;
const MAX_GROWTH_FLOOR = 60;
const MIN_SHRINK_FACTOR = 0.5;

/**
 * Why a keyword edit may not be applied, or null if it may. Each check bounds
 * a different way a reworded bullet could stop being true; none of them can
 * prove the bullet is still true, which is why the result stays a draft.
 */
function refuseEdit(
  edit: TailoringPlan['keywordEdits'][number],
  before: string,
  vacancyCorpus: string,
  resumeTokens: Set<string>,
): string | null {
  const after = edit.text.trim();
  const afterLower = after.toLowerCase();
  const vacancyLower = vacancyCorpus.toLowerCase();

  if (!after) return 'is empty';
  // A bullet is one line. A line break would let the text render as a heading
  // or a bullet of its own that the stored structure does not have.
  if (/[\r\n]/.test(after)) return 'contains a line break';

  for (const keyword of edit.keywords) {
    const k = keyword.trim().toLowerCase();
    if (!vacancyLower.includes(k)) return `"${keyword}" is not in the posting`;
    if (!afterLower.includes(k)) return `"${keyword}" is claimed but absent from the new wording`;
  }

  if (numbers(after).join('|') !== numbers(before).join('|')) {
    return 'changes the numbers in the bullet';
  }

  if (after.length > Math.max(before.length * MAX_GROWTH_FACTOR, before.length + MAX_GROWTH_FLOOR)) {
    return 'is much longer than the bullet it replaces';
  }
  // Rewording keeps what the bullet said; a much shorter one has dropped some of it.
  if (after.length < before.length * MIN_SHRINK_FACTOR) {
    return 'is much shorter than the bullet it replaces';
  }

  // A word may come from the resume, or from the posting *if it is claimed as a
  // keyword*. Claiming is what puts every posting term the edit introduces into
  // the change list the reader approves — an unclaimed one is refused.
  const claimed = new Set(edit.keywords.flatMap((keyword) => tokens(keyword)));
  const foreign = tokens(after).filter((token) => !resumeTokens.has(token) && !claimed.has(token));
  if (foreign.length) {
    return `uses words that are neither in the resume nor claimed as posting keywords (${[...new Set(foreign)].slice(0, 5).join(', ')})`;
  }

  return null;
}

/**
 * Applies a model's plan to the resume it was made from. The result is always
 * the source with bullets reordered and, where an edit passes every check, a
 * bullet reworded. Companies, titles, dates, education, languages and contacts
 * are copied from the source and are not reachable from a plan.
 *
 * Two kinds of bad input, treated differently on purpose:
 * - A reorder that is not a real permutation, or an index outside the resume,
 *   means the model misread the structure — everything else in the plan is
 *   suspect, so the whole plan is refused.
 * - A single edit that fails a check is dropped and reported. Nothing
 *   unchecked is ever applied, and one over-eager rewording does not cost the
 *   person a second paid call.
 */
export function applyTailoringPlan(
  source: ResumeStructure,
  vacancy: VacancyStructure,
  plan: TailoringPlan,
): TailoredResult {
  const structure = structuredClone(source);
  const changes: TailoringChanges = {
    highlightsReordered: [],
    skillsReordered: null,
    edits: [],
    rejectedEdits: [],
  };

  const vacancyCorpus = vacancyText(vacancy);
  const resumeTokens = new Set(tokens(resumeText(source)));

  // Edits first, against original indices, so reordering cannot change which
  // bullet an index means.
  const edited = source.experience.map((role) => [...role.highlights]);
  const touched = new Set<string>();
  for (const edit of plan.keywordEdits) {
    const { experienceIndex, highlightIndex } = edit;
    const before = source.experience[experienceIndex]?.highlights[highlightIndex];
    if (before === undefined) {
      throw new TailoringPlanError(
        `Edit points at role ${experienceIndex}, bullet ${highlightIndex}, which does not exist.`,
      );
    }
    const key = `${experienceIndex}:${highlightIndex}`;
    const reason = touched.has(key)
      ? 'the same bullet was edited twice'
      : refuseEdit(edit, before, vacancyCorpus, resumeTokens);
    if (reason) {
      changes.rejectedEdits.push({ experienceIndex, highlightIndex, reason });
      continue;
    }
    // Only an accepted edit claims the bullet, so a refused attempt followed by
    // a corrected one is judged on its own.
    touched.add(key);
    const after = edit.text.trim();
    if (after === before.trim()) continue;
    edited[experienceIndex][highlightIndex] = after;
    changes.edits.push({
      experienceIndex,
      highlightIndex,
      before,
      after,
      keywords: edit.keywords.map((keyword) => keyword.trim()),
    });
  }

  const orderedRoles = new Set<number>();
  for (const { experienceIndex, order } of plan.highlightOrder) {
    const role = structure.experience[experienceIndex];
    if (!role) {
      throw new TailoringPlanError(`Order refers to role ${experienceIndex}, which does not exist.`);
    }
    if (orderedRoles.has(experienceIndex)) {
      throw new TailoringPlanError(`Role ${experienceIndex} was ordered twice.`);
    }
    orderedRoles.add(experienceIndex);
    if (!isPermutation(order, role.highlights.length)) {
      throw new TailoringPlanError(
        `The order for role ${experienceIndex} is not a permutation of its ${role.highlights.length} bullets.`,
      );
    }
    if (!isIdentity(order)) {
      edited[experienceIndex] = order.map((i) => edited[experienceIndex][i]);
      changes.highlightsReordered.push({ experienceIndex, order });
    }
  }

  structure.experience.forEach((role, i) => {
    role.highlights = edited[i];
  });

  if (plan.skillsOrder.length > 0) {
    if (!isPermutation(plan.skillsOrder, source.skills.length)) {
      throw new TailoringPlanError(
        `The skills order is not a permutation of the ${source.skills.length} skills.`,
      );
    }
    if (!isIdentity(plan.skillsOrder)) {
      structure.skills = plan.skillsOrder.map((i) => source.skills[i]);
      changes.skillsReordered = plan.skillsOrder;
    }
  }

  return { structure, changes };
}
