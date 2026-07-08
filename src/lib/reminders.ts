/**
 * Overdue-reminder cadence. The schedule is a list of days-overdue thresholds
 * (default 1, 7, 14): one reminder per entry, sent once the invoice is at
 * least that many days past due. A minimum gap between sends protects
 * long-overdue backlogs from a burst of catch-up emails when reminders are
 * first enabled — capped at the schedule's own tightest interval so a
 * deliberately dense schedule (e.g. 1, 3, 5) still fires on time.
 */
export const DEFAULT_SCHEDULE: readonly number[] = [1, 7, 14];
export const MIN_GAP_DAYS = 5;
export const MAX_REMINDERS = 10;

/** Parse a user-entered schedule ('1, 7, 14') into sorted unique day counts.
 *  Junk entries are dropped; an empty result falls back to the default. */
export function parseSchedule(raw: string): number[] {
  const days = [
    ...new Set(
      raw
        .split(/[,\s]+/)
        .map(Number)
        .filter((n) => Number.isInteger(n) && n >= 1 && n <= 365)
    ),
  ]
    .sort((a, b) => a - b)
    .slice(0, MAX_REMINDERS);
  return days.length ? days : [...DEFAULT_SCHEDULE];
}

/** Whole days between two YYYY-MM-DD dates (b - a). */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

export function reminderDue(
  daysOverdue: number,
  remindersSent: number,
  daysSinceLast: number | null,
  schedule: readonly number[] = DEFAULT_SCHEDULE
): boolean {
  if (remindersSent >= schedule.length) return false;
  if (daysOverdue < schedule[remindersSent]) return false;
  const intervals = schedule.slice(1).map((d, i) => d - schedule[i]);
  const minGap = Math.min(MIN_GAP_DAYS, ...intervals);
  if (remindersSent > 0 && daysSinceLast !== null && daysSinceLast < minGap) return false;
  return true;
}
