import { describe, expect, it } from 'vitest';
import { compactHours, fmtTime, parseHours } from '../src/hours.js';

describe('parseHours', () => {
  it('reads weekday ranges with several time spans and an off day', () => {
    const h = parseHours('Mo-Th 11:00-22:00; Fr,Sa 11:00-14:30,17:00-23:00; Su off')!;
    expect(h.partial).toBe(false);
    expect(h.days[0].text).toBe('11:00–22:00');
    expect(h.days[4].text).toBe('11:00–14:30, 17:00–23:00');
    expect(h.days[6]).toMatchObject({ text: 'Closed', closed: true });
  });
  it('formats a 12-hour clock and summarises identical days', () => {
    const h = parseHours('09:00-17:00', { clock: 12 })!;
    expect(h.summary).toBe('Daily 9 AM–5 PM');
    expect(parseHours('Mo-Su 10:30-21:00', { clock: 12 })!.days[3].text).toBe('10:30 AM–9 PM');
  });
  it('handles 24/7 and wrapped day ranges', () => {
    expect(parseHours('24/7')!.summary).toBe('Open 24 hours');
    const h = parseHours('Fr-Mo 08:00-12:00')!;
    expect(h.days.filter((d) => !d.closed).map((d) => d.day)).toEqual([0, 4, 5, 6]);
  });
  it('lets later rules override earlier ones and ignores holiday rules', () => {
    const h = parseHours('Mo-Su 08:00-20:00; Su 10:00-16:00; PH off')!;
    expect(h.days[6].text).toBe('10:00–16:00');
    expect(h.days[0].text).toBe('08:00–20:00');
  });
  it('marks what it cannot read as partial, and gives up on nothing readable', () => {
    const h = parseHours('Mo-Fr 09:00-17:00; Sa sunrise-sunset')!;
    expect(h.partial).toBe(true);
    expect(h.days[5].text).toBe('See hours');
    expect(parseHours('by appointment')).toBeNull();
    expect(parseHours('')).toBeNull();
  });
  it('compacts consecutive identical days', () => {
    const rows = compactHours(parseHours('Mo-Fr 09:00-17:00; Sa 10:00-14:00; Su off')!);
    expect(rows.map((r) => [r.label, r.text])).toEqual([
      ['Mon–Fri', '09:00–17:00'],
      ['Sat', '10:00–14:00'],
      ['Sun', 'Closed'],
    ]);
  });
  it('fmtTime handles noon, midnight and 24:00', () => {
    expect(fmtTime('12:00', 12)).toBe('12 PM');
    expect(fmtTime('00:00', 12)).toBe('12 AM');
    expect(fmtTime('24:00', 12)).toBe('12 AM');
    expect(fmtTime('23:15', 24)).toBe('23:15');
    expect(fmtTime('25:00', 24)).toBeNull();
  });
});
