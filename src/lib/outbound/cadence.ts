/**
 * Monitor cadence → "is a re-check due?". `monitors.cadence` is a standard 5-field cron expression evaluated in UTC
 * (minute hour day-of-month month day-of-week; `*`, lists `1,15`, ranges `1-5`, steps `*\/6` and `9-17/2`,
 * names JAN-DEC / SUN-SAT; day-of-week 0 and 7 are Sunday). Also accepted: @hourly @daily @weekly @monthly and the
 * bare words hourly / daily / weekly / monthly. A monitor is due when a scheduled time has passed since its last check
 * (or since it was created, if never checked).
 */

interface Cron {
  minutes: Set<number>;
  hours: Set<number>;
  days: Set<number>;
  months: Set<number>;
  weekdays: Set<number>;
  daysRestricted: boolean;
  weekdaysRestricted: boolean;
}

const MACROS: Record<string, string> = {
  hourly: "0 * * * *",
  daily: "0 0 * * *",
  weekly: "0 0 * * 0",
  monthly: "0 0 1 * *",
};
const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function parseField(field: string, min: number, max: number, names: string[] = [], nameBase = 0): Set<number> | null {
  const out = new Set<number>();
  const value = (s: string) => {
    const i = names.indexOf(s.toLowerCase());
    const n = i >= 0 ? i + nameBase : /^\d+$/.test(s) ? Number(s) : NaN;
    return n >= min && n <= max ? n : NaN;
  };
  for (const part of field.split(",")) {
    const [range, stepText] = part.split("/");
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) return null;
    let lo: number;
    let hi: number;
    if (range === "*") [lo, hi] = [min, max];
    else if (range.includes("-")) [lo, hi] = range.split("-").map(value) as [number, number];
    else [lo, hi] = [value(range), stepText === undefined ? value(range) : max];
    if (Number.isNaN(lo) || Number.isNaN(hi) || lo > hi) return null;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

export function parseCadence(cadence: string): Cron | null {
  const text = cadence.trim().toLowerCase().replace(/^@/, "");
  const fields = (MACROS[text] ?? text).split(/\s+/);
  if (fields.length !== 5) return null;
  const minutes = parseField(fields[0], 0, 59);
  const hours = parseField(fields[1], 0, 23);
  const days = parseField(fields[2], 1, 31);
  const months = parseField(fields[3], 1, 12, MONTH_NAMES, 1);
  const weekdays = parseField(fields[4], 0, 7, DAY_NAMES);
  if (!minutes || !hours || !days || !months || !weekdays) return null;
  if (weekdays.delete(7)) weekdays.add(0);
  return { minutes, hours, days, months, weekdays, daysRestricted: fields[2] !== "*", weekdaysRestricted: fields[4] !== "*" };
}

/** Classic cron: when both day fields are restricted, either may match. */
function dayMatches(c: Cron, t: Date): boolean {
  const dom = c.days.has(t.getUTCDate());
  const dow = c.weekdays.has(t.getUTCDay());
  if (c.daysRestricted && c.weekdaysRestricted) return dom || dow;
  return dom && dow;
}

/** First scheduled minute strictly after `after`, searching up to 5 years ahead. */
export function nextRun(c: Cron, after: Date): Date | null {
  const t = new Date(after.getTime());
  t.setUTCSeconds(0, 0);
  t.setUTCMinutes(t.getUTCMinutes() + 1);
  const limit = after.getTime() + 5 * 366 * 86_400_000;
  while (t.getTime() <= limit) {
    if (!c.months.has(t.getUTCMonth() + 1)) {
      t.setUTCMonth(t.getUTCMonth() + 1, 1);
      t.setUTCHours(0, 0, 0, 0);
    } else if (!dayMatches(c, t)) {
      t.setUTCDate(t.getUTCDate() + 1);
      t.setUTCHours(0, 0, 0, 0);
    } else if (!c.hours.has(t.getUTCHours())) {
      t.setUTCHours(t.getUTCHours() + 1, 0, 0, 0);
    } else if (!c.minutes.has(t.getUTCMinutes())) {
      t.setUTCMinutes(t.getUTCMinutes() + 1, 0, 0);
    } else {
      return t;
    }
  }
  return null;
}

/** Due when a scheduled time falls in (lastCheck, now]. Unparseable cadences count as daily so a monitor never silently stops. */
export function isDue(cadence: string, lastCheck: Date, now = new Date()): { due: boolean; next: Date | null; valid: boolean } {
  const parsed = parseCadence(cadence);
  const next = nextRun(parsed ?? (parseCadence("daily") as Cron), lastCheck);
  return { due: next !== null && next.getTime() <= now.getTime(), next, valid: parsed !== null };
}
