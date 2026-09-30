import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { TEMPLATES, assertTemplateTextAvailable } from './index';
import type { PromptTemplate } from './template.types';

/**
 * The registry pins a `version` alongside each prompt, and that version labels
 * every usage row and every piece of generated content. Nothing, however,
 * forces a human to bump it when they edit the prose — and a silent edit is
 * the worst case: self-audit would compare outputs from two different prompts
 * under one label and read the difference as a change in the world.
 *
 * So the expected text is pinned here by hash. Editing a prompt fails this
 * test, and the fix is to bump the template's version and paste the new hash —
 * two deliberate actions instead of one forgettable one.
 */
const PINNED: Record<string, { version: string; sha256: string }> = {
  onboarding_parse: {
    version: 'onboarding-parse-v1',
    sha256: '901d29a3fc7595bc5bde7f3e24ba44b83211137cdb3fd3e38e8749115ff71244',
  },
  resume_extract: {
    version: 'resume-extract-v1',
    sha256: '5626e6e833d81986d37b577a8fdf5cc6bee409a727e6b8bc60fd868d992f00ce',
  },
  vacancy_parse: {
    version: 'vacancy-parse-v1',
    sha256: 'a124353142c61e7adac59a5c8f0f3fc8438354e6a8486135a72b99580b358807',
  },
  vacancy_score: {
    version: 'vacancy-score-v1',
    sha256: '3bba14de7298c67da0e05043b71c07595eefae3074bf8af5e2323c408b2c6333',
  },
  chat: {
    version: 'chat-v1',
    sha256: '154e3ee728438dee35e934c48b7408e5ec2323cd5ad42e0c1645edb4cbfa7fa7',
  },
};

/**
 * Covers the whole template, not just the prose: `maxTokens` changes what the
 * model can produce and what an attempt costs, and the untrusted labels change
 * what the prompt is fed. Both move outputs, so both should force a version
 * bump — pinning only the text would let them through unnoticed.
 */
function fingerprint(template: PromptTemplate): string {
  const material = JSON.stringify({
    taskType: template.taskType,
    untrusted: template.untrusted,
    maxTokens: template.maxTokens,
    // Rendered with no params, so the language/market lines a caller happens
    // to pass don't enter the fingerprint.
    text: template.build({}),
  });
  return createHash('sha256').update(material).digest('hex');
}

describe('prompt template versions', () => {
  it('has every template’s prose available (build asset check)', () => {
    expect(() => assertTemplateTextAvailable()).not.toThrow();
  });

  it('every registry entry is pinned here', () => {
    expect(Object.keys(PINNED).sort()).toEqual(Object.keys(TEMPLATES).sort());
  });

  it.each(Object.entries(TEMPLATES))('%s matches its pinned version', (name, template) => {
    const pinned = PINNED[name];
    expect(pinned.version).toBe(template.version);
    expect(fingerprint(template)).toBe(pinned.sha256);
  });
});
