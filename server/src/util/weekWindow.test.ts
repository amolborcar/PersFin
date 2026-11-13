import { describe, it, expect } from 'vitest';

// Run in a zone with daylight saving so the boundary checks below cross a
// clock change (US DST 2026: starts Sun Mar 8, ends Sun Nov 1).
process.env.TZ = 'America/New_York';
const { reportWeek, weekContaining, shiftWeek, weekFromKey, monthProgress } = await import('./weekWindow.js');

const at = (y: number, m: number, d: number, h = 19) => new Date(y, m - 1, d, h, 0, 0);

describe('week windows (Monday–Sunday, local time)', () => {
  it('reports the current week on its Sunday, and the last finished week on other days', () => {
    expect(reportWeek(at(2026, 11, 15))).toEqual({ key: '2026-11-09', start: '2026-11-09', end: '2026-11-15' }); // Sunday
    expect(reportWeek(at(2026, 11, 16, 0))).toEqual({ key: '2026-11-09', start: '2026-11-09', end: '2026-11-15' }); // Monday 00:00
    expect(reportWeek(at(2026, 11, 13))).toEqual({ key: '2026-11-02', start: '2026-11-02', end: '2026-11-08' }); // Friday
  });

  it('keeps whole weeks across daylight-saving changes', () => {
    expect(weekContaining('2026-03-08')).toEqual({ key: '2026-03-02', start: '2026-03-02', end: '2026-03-08' });
    expect(shiftWeek(weekContaining('2026-03-08'), 1)).toEqual({ key: '2026-03-09', start: '2026-03-09', end: '2026-03-15' });
    expect(weekContaining('2026-11-01')).toEqual({ key: '2026-10-26', start: '2026-10-26', end: '2026-11-01' });
    expect(shiftWeek(weekContaining('2026-11-01'), -1).end).toBe('2026-10-25');
  });

  it('spans the year end', () => {
    expect(weekContaining('2026-12-31')).toEqual({ key: '2026-12-28', start: '2026-12-28', end: '2027-01-03' });
    expect(reportWeek(at(2027, 1, 2))).toEqual({ key: '2026-12-21', start: '2026-12-21', end: '2026-12-27' });
    expect(shiftWeek(weekContaining('2027-01-01'), -8).key).toBe('2026-11-02');
  });

  it('accepts only a Monday as a week key', () => {
    expect(weekFromKey('2026-11-09')).toEqual({ key: '2026-11-09', start: '2026-11-09', end: '2026-11-15' });
    expect(weekFromKey('2026-11-10')).toBeNull();
    expect(weekFromKey('nope')).toBeNull();
  });

  it('measures month progress', () => {
    expect(monthProgress('2026-02-14')).toEqual({ monthKey: '2026-02', daysInMonth: 28, daysElapsed: 14 });
    expect(monthProgress('2028-02-29')).toEqual({ monthKey: '2028-02', daysInMonth: 29, daysElapsed: 29 });
  });
});
