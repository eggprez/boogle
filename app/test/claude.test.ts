import { describe, expect, it } from 'vitest';
import { buildUserPrompt, PROMPT_VERSION, splitRelated, systemPrompt } from '../src/overview/claude.js';
import { overviewKey } from '../src/overview/index.js';

describe('splitRelated', () => {
  it('extracts a trailing related block', () => {
    const { text, related } = splitRelated('Answer here [1].\n\n```related\nfoo bar\n- baz qux\n3. third one\n```\n');
    expect(text).toBe('Answer here [1].');
    expect(related).toEqual(['foo bar', 'baz qux', 'third one']);
  });
  it('leaves text without a block alone', () => {
    expect(splitRelated('Just text.')).toEqual({ text: 'Just text.', related: [] });
  });
  it('ignores a related block that is not at the end', () => {
    const { text, related } = splitRelated('```related\na\n```\nMore text after.');
    expect(related).toEqual([]);
    expect(text).toContain('More text after.');
  });
  it('caps at three queries', () => {
    expect(splitRelated('x\n```related\n1\n2\n3\n4\n5\n```').related).toHaveLength(3);
  });
});

describe('prompts', () => {
  const src = { n: 1, title: 'T', url: 'https://a.com/x', host: 'a.com', text: 'snippet text' };
  it('knowledge mode answers from the model and treats results as citations only', () => {
    const sys = systemPrompt('Boogle', 'knowledge');
    expect(sys).toMatch(/from your own knowledge/);
    expect(sys).not.toMatch(/using ONLY those sources/);
    const user = buildUserPrompt({ query: 'cats', sources: [src], mode: 'knowledge' });
    expect(user).toMatch(/for citations and freshness only/);
    expect(user).toContain('[1] T — a.com');
  });
  it('snippet and deep modes stay grounded in the sources', () => {
    expect(systemPrompt('Boogle', 'snippets')).toMatch(/using ONLY those sources/);
    expect(systemPrompt('Boogle', 'deep')).toMatch(/full article text/);
    expect(buildUserPrompt({ query: 'cats', sources: [src], mode: 'deep' })).toMatch(/full article text/);
  });
  it('knowledge mode copes with an empty result list', () => {
    expect(buildUserPrompt({ query: 'cats', sources: [], mode: 'knowledge' })).toMatch(/answer without citations/);
  });
});

describe('overviewKey', () => {
  it('is stable and case-insensitive on the query', () => {
    expect(overviewKey('Cats', 'snippets', 'sonnet', 'auto')).toBe(overviewKey('cats ', 'snippets', 'sonnet', 'auto'));
  });
  it('changes with mode, model, language, time range', () => {
    const base = overviewKey('cats', 'snippets', 'sonnet', 'auto');
    expect(overviewKey('cats', 'deep', 'sonnet', 'auto')).not.toBe(base);
    expect(overviewKey('cats', 'snippets', 'haiku', 'auto')).not.toBe(base);
    expect(overviewKey('cats', 'snippets', 'sonnet', 'de')).not.toBe(base);
    expect(overviewKey('cats', 'snippets', 'sonnet', 'auto', 'week')).not.toBe(base);
  });
  it('embeds the prompt version', () => {
    expect(PROMPT_VERSION).toMatch(/^[0-9a-f]{10}$/);
  });
});
