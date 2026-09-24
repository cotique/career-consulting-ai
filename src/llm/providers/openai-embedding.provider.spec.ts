import { describe, expect, it } from 'vitest';
import { redactApiKey } from './openai-embedding.provider';

describe('redactApiKey (T22 incident fix)', () => {
  it('redacts the masked key OpenAI\'s own 401 body echoes back', () => {
    const body =
      'Incorrect API key provided: sk-C9FjM***************************************6Kn8. You can find your API key at https://platform.openai.com/account/api-keys.';
    const redacted = redactApiKey(body);
    expect(redacted).not.toContain('sk-C9FjM');
    expect(redacted).not.toContain('6Kn8');
    expect(redacted).toContain('[redacted]');
    expect(redacted).toContain('Incorrect API key provided');
  });

  it('leaves text with nothing key-shaped unchanged', () => {
    expect(redactApiKey('rate limit exceeded, try again later')).toBe('rate limit exceeded, try again later');
  });
});
