// Calendar weeks for the weekly report: Monday to Sunday in the machine's local
// time zone. Pure date arithmetic on calendar fields (never "+ 7 × 86 400 000
// ms"), so a daylight-saving change inside a week can't shift a boundary.

export interface WeekWindow {
  key: string;    // the Monday, YYYY-MM-DD — the report's id
  start: string;  // Monday, YYYY-MM-DD (inclusive)
  end: string;    // Sunday, YYYY-MM-DD (inclusive)
}

const pad = (n: number) => String(n).padStart(2, '0');
export const isoDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fromIso = (iso: string) => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d); };
export const addDays = (iso: string, n: number) => { const d = fromIso(iso); return isoDay(new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)); };

// The week (Mon–Sun) that contains `day`.
export function weekContaining(day: string): WeekWindow {
  const d = fromIso(day);
  const sinceMonday = (d.getDay() + 6) % 7; // Mon = 0 … Sun = 6
  const start = addDays(day, -sinceMonday);
  return { key: start, start, end: addDays(start, 6) };
}

// The week to report on at `now`: the current week on a Sunday (the report runs
// Sunday evening), otherwise the last week that has ended.
export function reportWeek(now: Date = new Date()): WeekWindow {
  const today = isoDay(now);
  const w = weekContaining(today);
  return w.end === today ? w : shiftWeek(w, -1);
}

export function shiftWeek(w: WeekWindow, weeks: number): WeekWindow {
  return weekContaining(addDays(w.start, weeks * 7));
}

export function weekFromKey(key: string): WeekWindow | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return null;
  const w = weekContaining(key);
  return w.key === key ? w : null; // must be a Monday
}

// Days in the month of `day`, and how many of them have passed through `day`.
export function monthProgress(day: string): { monthKey: string; daysInMonth: number; daysElapsed: number } {
  const d = fromIso(day);
  return {
    monthKey: day.slice(0, 7),
    daysInMonth: new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate(),
    daysElapsed: d.getDate(),
  };
}

// The hour (local) on Sunday when the weekly report is sent; launchd and
// node-cron trigger the weekly-report job then.
export const WEEKLY_SEND_HOUR = 19;

// The week whose report is due at `now`: the current week from Sunday
// WEEKLY_SEND_HOUR on, otherwise the last week that has ended. Unlike
// reportWeek, a catch-up on Sunday morning never sends a week that is not over.
export function dueWeek(now: Date = new Date()): WeekWindow {
  const w = weekContaining(isoDay(now));
  return w.end === isoDay(now) && now.getHours() >= WEEKLY_SEND_HOUR ? w : shiftWeek(w, -1);
}
