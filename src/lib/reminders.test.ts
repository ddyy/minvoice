import { describe, expect, it } from 'vitest';
import { daysBetween, parseSchedule, reminderDue } from './reminders';

describe('daysBetween', () => {
  it('computes whole days across months', () => {
    expect(daysBetween('2026-07-04', '2026-07-08')).toBe(4);
    expect(daysBetween('2026-06-20', '2026-07-08')).toBe(18);
    expect(daysBetween('2026-07-08', '2026-07-08')).toBe(0);
  });
});

describe('parseSchedule', () => {
  it('parses, sorts, and dedupes', () => {
    expect(parseSchedule('1, 7, 14')).toEqual([1, 7, 14]);
    expect(parseSchedule('14 7 1 7')).toEqual([1, 7, 14]);
    expect(parseSchedule('3,30')).toEqual([3, 30]);
  });

  it('drops junk and falls back to the default when nothing survives', () => {
    expect(parseSchedule('1, banana, 7, -2, 0, 400, 2.5')).toEqual([1, 7]);
    expect(parseSchedule('')).toEqual([1, 7, 14]);
    expect(parseSchedule('nope')).toEqual([1, 7, 14]);
  });

  it('caps the list at 10 reminders', () => {
    expect(parseSchedule('1,2,3,4,5,6,7,8,9,10,11,12')).toHaveLength(10);
  });
});

describe('reminderDue', () => {
  it('first reminder at 1 day overdue', () => {
    expect(reminderDue(0, 0, null)).toBe(false);
    expect(reminderDue(1, 0, null)).toBe(true);
  });

  it('second at 7 days, third at 14, then stops', () => {
    expect(reminderDue(6, 1, 5)).toBe(false);
    expect(reminderDue(7, 1, 6)).toBe(true);
    expect(reminderDue(14, 2, 7)).toBe(true);
    expect(reminderDue(60, 3, 30)).toBe(false);
  });

  it('spaces reminders at least 5 days apart (no catch-up bursts)', () => {
    // 20 days overdue, first reminder sent yesterday: second must wait
    expect(reminderDue(20, 1, 1)).toBe(false);
    expect(reminderDue(24, 1, 5)).toBe(true);
  });

  it('honors a custom schedule and its length', () => {
    const schedule = [3, 30];
    expect(reminderDue(2, 0, null, schedule)).toBe(false);
    expect(reminderDue(3, 0, null, schedule)).toBe(true);
    expect(reminderDue(30, 1, 27, schedule)).toBe(true);
    expect(reminderDue(90, 2, 60, schedule)).toBe(false);
  });

  it('relaxes the anti-burst gap for deliberately dense schedules', () => {
    // 1, 3, 5 has 2-day intervals — a 5-day gap would make it unsatisfiable
    const dense = [1, 3, 5];
    expect(reminderDue(3, 1, 2, dense)).toBe(true);
    expect(reminderDue(3, 1, 1, dense)).toBe(false);
  });
});
