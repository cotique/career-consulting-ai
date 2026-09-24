import { describe, expect, it } from 'vitest';
import { MAX_EMBED_CHARS, renderResumeExtractionText, renderVacancyText } from './chunk-source';

describe('chunk source rendering (retrieval infrastructure)', () => {
  it('renders a resume extraction to its JSON text', () => {
    const structured = { name: 'Jane Doe', headline: 'Backend Engineer' };
    expect(renderResumeExtractionText(structured)).toBe(JSON.stringify(structured));
  });

  it('truncates an oversized resume extraction rather than sending it whole', () => {
    const huge = { summary: 'x'.repeat(MAX_EMBED_CHARS * 2) };
    const rendered = renderResumeExtractionText(huge);
    expect(rendered.length).toBe(MAX_EMBED_CHARS);
  });

  it('renders a vacancy to its raw text, unchanged if short', () => {
    expect(renderVacancyText('Senior Engineer at Acme')).toBe('Senior Engineer at Acme');
  });

  it('truncates a vacancy posting near MAX_PASTE_CHARS rather than assuming it fits the embedding model', () => {
    const long = 'x'.repeat(60_000); // MAX_PASTE_CHARS, src/intake/paste.ts
    expect(renderVacancyText(long).length).toBe(MAX_EMBED_CHARS);
  });
});
