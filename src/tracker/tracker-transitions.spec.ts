import { describe, expect, it } from 'vitest';
import { APPLICATION_STATUSES, assertTransition, type ApplicationStatus } from './tracker-transitions';

const VALID_PAIRS: Array<[ApplicationStatus, ApplicationStatus]> = [
  ['sourced', 'applied'],
  ['sourced', 'rejected'],
  ['sourced', 'withdrawn'],
  ['applied', 'interview_scheduled'],
  ['applied', 'rejected'],
  ['applied', 'withdrawn'],
  ['interview_scheduled', 'interview_completed'],
  ['interview_scheduled', 'rejected'],
  ['interview_scheduled', 'withdrawn'],
  ['interview_completed', 'interview_scheduled'],
  ['interview_completed', 'offer'],
  ['interview_completed', 'rejected'],
  ['interview_completed', 'withdrawn'],
];

const ALL_PAIRS: Array<[ApplicationStatus, ApplicationStatus]> = APPLICATION_STATUSES.flatMap((from) =>
  APPLICATION_STATUSES.map((to) => [from, to] as [ApplicationStatus, ApplicationStatus]),
);

const VALID_SET = new Set(VALID_PAIRS.map(([from, to]) => `${from}->${to}`));
const INVALID_PAIRS = ALL_PAIRS.filter(([from, to]) => from !== to && !VALID_SET.has(`${from}->${to}`));

describe('tracker state machine (T21)', () => {
  it.each(VALID_PAIRS)('allows %s -> %s', (from, to) => {
    expect(() => assertTransition(from, to)).not.toThrow();
  });

  it.each(INVALID_PAIRS)('refuses %s -> %s', (from, to) => {
    expect(() => assertTransition(from, to)).toThrow(/cannot move/i);
  });

  it.each(['offer', 'rejected', 'withdrawn'] as const)('%s is terminal — no outbound transition at all', (from) => {
    for (const to of APPLICATION_STATUSES) {
      if (to === from) continue;
      expect(() => assertTransition(from, to)).toThrow();
    }
  });

  it.each(APPLICATION_STATUSES)('refuses staying at %s — no status is its own transition', (status) => {
    expect(() => assertTransition(status, status)).toThrow(/cannot move/i);
  });
});
