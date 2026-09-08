// OpenStreetMap opening_hours ("Mo-Fr 11:00-22:00; Sa,Su 12:00-23:00; PH off")
// turned into a row per weekday, so a panel can show a readable table
// instead of the raw string. This covers the common grammar: weekday sets
// and ranges, several time ranges per rule, "off"/"closed", "24/7", and
// later rules overriding earlier ones. Anything stranger (months, week
// numbers, sunrise, comments) leaves the day marked "see hours" and the raw
// string is shown as well.

export const DAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'] as const;
export const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

export interface DayHours {
  /** 0 = Monday … 6 = Sunday */
  day: number;
  /** "11:00–22:00", "Closed", "Open 24 hours", "See hours" */
  text: string;
  closed: boolean;
}

export interface Hours {
  days: DayHours[];
  /** the rule text could not be fully understood */
  partial: boolean;
  /** a summary when every day is the same: "Daily 09:00–17:00" */
  summary?: string;
}

const DAY_INDEX: Record<string, number> = { mo: 0, tu: 1, we: 2, th: 3, fr: 4, sa: 5, su: 6 };
const TIME = /^(\d{1,2}):(\d{2})$/;

/** Parse an opening_hours string. Returns null when nothing in it is understood. */
export function parseHours(raw: string, opts: { clock?: 12 | 24 } = {}): Hours | null {
  const s = raw.trim();
  if (!s) return null;
  const clock = opts.clock ?? 24;
  const table: (string[] | 'closed' | 'unknown' | null)[] = [null, null, null, null, null, null, null];
  let partial = false;
  let understood = 0;

  if (/^24\s*\/\s*7$/.test(s)) {
    return { days: DAYS.map((_, i) => ({ day: i, text: 'Open 24 hours', closed: false })), partial: false, summary: 'Open 24 hours' };
  }

  for (const ruleRaw of s.split(/\s*;\s*|\s*\|\|\s*/)) {
    const rule = ruleRaw.replace(/"[^"]*"/g, '').trim();
    if (!rule) continue;
    // Public/school holidays: not weekday rows.
    if (/^(PH|SH)\b/.test(rule)) continue;
    const m = /^((?:(?:Mo|Tu|We|Th|Fr|Sa|Su)(?:\s*-\s*(?:Mo|Tu|We|Th|Fr|Sa|Su))?(?:\s*,\s*)?)+)?\s*(.*)$/.exec(rule);
    if (!m) {
      partial = true;
      continue;
    }
    const dayPart = (m[1] ?? '').trim();
    const timePart = m[2].trim().replace(/,\s*PH\b|\bPH\s*,?/g, '').trim();
    const days = dayPart ? parseDays(dayPart) : [0, 1, 2, 3, 4, 5, 6];
    if (!days) {
      partial = true;
      continue;
    }
    let value: string[] | 'closed' | 'unknown';
    if (/^(off|closed)$/i.test(timePart) || timePart === '') {
      value = timePart === '' && !dayPart ? 'unknown' : 'closed';
    } else if (/^24\s*\/\s*7$/.test(timePart) || /^00:00\s*-\s*24:00$/.test(timePart)) {
      value = ['Open 24 hours'];
    } else {
      const ranges = timePart.split(/\s*,\s*/).map((r) => parseRange(r, clock));
      if (ranges.some((r) => r === null)) {
        partial = true;
        value = 'unknown';
      } else value = ranges as string[];
    }
    for (const d of days) table[d] = value;
    if (value !== 'unknown') understood++;
  }
  if (!understood) return null;

  const days: DayHours[] = table.map((v, i) => {
    if (v === null || v === 'closed') return { day: i, text: 'Closed', closed: true };
    if (v === 'unknown') return { day: i, text: 'See hours', closed: false };
    return { day: i, text: v.join(', '), closed: false };
  });
  const first = days[0].text;
  const summary = days.every((d) => d.text === first) ? (days[0].closed ? undefined : first === 'Open 24 hours' ? first : `Daily ${first}`) : undefined;
  return { days, partial, summary };
}

function parseDays(part: string): number[] | null {
  const out = new Set<number>();
  for (const piece of part.split(/\s*,\s*/)) {
    const r = /^(Mo|Tu|We|Th|Fr|Sa|Su)(?:\s*-\s*(Mo|Tu|We|Th|Fr|Sa|Su))?$/i.exec(piece.trim());
    if (!r) return null;
    const a = DAY_INDEX[r[1].toLowerCase()];
    const b = r[2] ? DAY_INDEX[r[2].toLowerCase()] : a;
    for (let d = a; ; d = (d + 1) % 7) {
      out.add(d);
      if (d === b) break;
    }
  }
  return [...out];
}

function parseRange(r: string, clock: 12 | 24): string | null {
  const m = /^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})\+?$/.exec(r.trim());
  if (!m) return null;
  const a = fmtTime(m[1], clock);
  const b = fmtTime(m[2], clock);
  return a && b ? `${a}–${b}` : null;
}

/** "13:30" → "1:30 PM" on a 12-hour clock; "24:00" reads as midnight. */
export function fmtTime(t: string, clock: 12 | 24): string | null {
  const m = TIME.exec(t);
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2];
  if (h > 24 || Number(min) > 59) return null;
  if (clock === 24) return `${String(h % 24).padStart(2, '0')}:${min}`;
  const suffix = h >= 12 && h < 24 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return min === '00' ? `${h} ${suffix}` : `${h}:${min} ${suffix}`;
}

/**
 * Compact rows for a table: consecutive days with the same hours collapse
 * into one line ("Mon–Fri 11 AM–10 PM"), the way Google prints them.
 */
export function compactHours(h: Hours): { label: string; text: string; closed: boolean; days: number[] }[] {
  const rows: { label: string; text: string; closed: boolean; days: number[] }[] = [];
  for (const d of h.days) {
    const last = rows[rows.length - 1];
    if (last && last.text === d.text && last.days[last.days.length - 1] === d.day - 1) {
      last.days.push(d.day);
      const a = DAY_NAMES[last.days[0]].slice(0, 3);
      const b = DAY_NAMES[d.day].slice(0, 3);
      last.label = last.days.length > 2 ? `${a}–${b}` : `${a}, ${b}`;
    } else rows.push({ label: DAY_NAMES[d.day].slice(0, 3), text: d.text, closed: d.closed, days: [d.day] });
  }
  return rows;
}

/**
 * Google's weekdayDescriptions ("Monday: 11:00 AM – 10:00 PM", "Sunday:
 * Closed") as the same Hours shape, so both sources render alike.
 */
export function hoursFromGoogle(lines: string[]): Hours | null {
  const days: DayHours[] = [];
  for (const line of lines) {
    const m = /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday):\s*(.+)$/.exec(line.trim());
    if (!m) continue;
    const day = DAY_NAMES.indexOf(m[1]);
    const text = m[2].replace(/\s*[–-]\s*/g, '–').replace(/\u202f|\u2009/g, ' ').trim();
    const closed = /^closed$/i.test(text);
    days.push({ day, text: closed ? 'Closed' : /24 hours/i.test(text) ? 'Open 24 hours' : text, closed });
  }
  if (days.length !== 7) return null;
  days.sort((a, b) => a.day - b.day);
  const first = days[0].text;
  const summary = days.every((d) => d.text === first) && !days[0].closed ? (first === 'Open 24 hours' ? first : `Daily ${first}`) : undefined;
  return { days, partial: false, summary };
}
