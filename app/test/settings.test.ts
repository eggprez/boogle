import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, sanitize } from '../src/settings.js';

describe('sanitize', () => {
  it('returns defaults for empty input', () => {
    expect(sanitize({})).toEqual(DEFAULT_SETTINGS);
  });
  it('accepts form-style booleans', () => {
    expect(sanitize({ overviewEnabled: 'on' }).overviewEnabled).toBe(true);
    expect(sanitize({ overviewEnabled: 'off' }).overviewEnabled).toBe(false);
    expect(sanitize({ openInNewTab: 'true' }).openInNewTab).toBe(true);
  });
  it('rejects unknown enum values', () => {
    expect(sanitize({ model: 'gpt-9' }).model).toBe('sonnet');
    expect(sanitize({ overviewMode: 'turbo' }).overviewMode).toBe('snippets');
    expect(sanitize({ theme: 'sepia' }).theme).toBe('system');
    expect(sanitize({ safesearch: '7' }).safesearch).toBe(0);
  });
  it('accepts valid values', () => {
    const s = sanitize({ model: 'opus', overviewMode: 'deep', theme: 'dark', safesearch: '2', language: 'en-GB' });
    expect(s).toMatchObject({ model: 'opus', overviewMode: 'deep', theme: 'dark', safesearch: 2, language: 'en-GB' });
  });
  it('rejects injection-looking language codes', () => {
    expect(sanitize({ language: 'en;rm -rf' }).language).toBe('auto');
    expect(sanitize({ language: 'x'.repeat(40) }).language).toBe('auto');
  });
});
