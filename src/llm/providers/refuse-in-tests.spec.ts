import { describe, expect, it } from 'vitest';
import { assertNotUnderTest } from './refuse-in-tests';

describe('assertNotUnderTest (T22 incident guard)', () => {
  it('throws under a test run — VITEST is set by the runner itself', () => {
    // No need to set it: this file only runs under Vitest, so it's already set.
    expect(process.env.VITEST).toBeTruthy();
    expect(() => assertNotUnderTest('SomeProvider')).toThrow(/SomeProvider/);
    expect(() => assertNotUnderTest('SomeProvider')).toThrow(/real network call/);
  });

  it('does not throw once VITEST is unset — the production path', () => {
    const original = process.env.VITEST;
    delete process.env.VITEST;
    try {
      expect(() => assertNotUnderTest('SomeProvider')).not.toThrow();
    } finally {
      process.env.VITEST = original;
    }
  });
});
