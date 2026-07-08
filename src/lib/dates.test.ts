import { describe, expect, it } from 'vitest';
import { addDaysISO, formatTimestamp, isValidTimezone, todayInTz } from './dates';

describe('todayInTz', () => {
  it('returns ISO dates', () => {
    expect(todayInTz('UTC')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(todayInTz('America/Los_Angeles')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('isValidTimezone', () => {
  it('accepts IANA names and rejects junk', () => {
    expect(isValidTimezone('America/Los_Angeles')).toBe(true);
    expect(isValidTimezone('UTC')).toBe(true);
    expect(isValidTimezone('Mars/Olympus')).toBe(false);
    expect(isValidTimezone('')).toBe(false);
  });
});

describe('formatTimestamp', () => {
  it('converts stored UTC datetimes into the business time zone', () => {
    // 2026-07-01 23:26 UTC == 16:26 in Los Angeles (PDT, UTC-7)
    expect(formatTimestamp('2026-07-01 23:26:25', 'America/Los_Angeles')).toBe('2026-07-01 16:26');
    // and can cross the date line backwards
    expect(formatTimestamp('2026-07-02 06:36:45', 'America/Los_Angeles')).toBe('2026-07-01 23:36');
  });

  it('passes date-only values (backdates) through untouched', () => {
    expect(formatTimestamp('2026-06-30', 'America/Los_Angeles')).toBe('2026-06-30');
  });

  it('leaves unparseable values as-is', () => {
    expect(formatTimestamp('not a date at all', 'UTC')).toBe('not a date at all');
  });
});

describe('addDaysISO', () => {
  it('adds calendar days', () => {
    expect(addDaysISO('2026-07-02', 14)).toBe('2026-07-16');
    expect(addDaysISO('2026-07-31', 1)).toBe('2026-08-01'); // month rollover
    expect(addDaysISO('2026-12-31', 1)).toBe('2027-01-01'); // year rollover
    expect(addDaysISO('2028-02-28', 1)).toBe('2028-02-29'); // leap year
  });
});
