import { describe, expect, it } from 'vitest';
import { parseTimeRange, TIME_RANGES } from '../src/searxng.js';

describe('parseTimeRange', () => {
  it('accepts the four SearXNG ranges', () => {
    for (const r of ['day', 'week', 'month', 'year']) expect(parseTimeRange(r)).toBe(r);
  });
  it('falls back to any time for junk', () => {
    expect(parseTimeRange(undefined)).toBe('');
    expect(parseTimeRange('decade')).toBe('');
    expect(parseTimeRange(['day'])).toBe('');
  });
  it('lists any-time first', () => {
    expect(TIME_RANGES[0].id).toBe('');
  });
});
