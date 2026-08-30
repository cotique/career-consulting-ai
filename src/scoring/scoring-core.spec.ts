import { describe, expect, it } from 'vitest';
import { missingScoringInput } from './scoring-core';

describe('scoring input completeness (T17)', () => {
  it('reports a missing profile rather than letting scoring proceed against nothing', () => {
    expect(missingScoringInput(null, { some: 'extraction' })).toBe('missing_profile');
    expect(missingScoringInput(undefined, { some: 'extraction' })).toBe('missing_profile');
  });

  it('reports a missing resume extraction when the profile exists but nothing was extracted', () => {
    expect(missingScoringInput({ some: 'profile' }, null)).toBe('missing_resume');
    expect(missingScoringInput({ some: 'profile' }, undefined)).toBe('missing_resume');
  });

  it('reports nothing missing once both are present', () => {
    expect(missingScoringInput({ some: 'profile' }, { some: 'extraction' })).toBeNull();
  });
});
