/** Delivery policy for the email outbox — pure so it's unit-testable. */

export const MAX_OUTBOX_ATTEMPTS = 8;

/**
 * Minutes to wait before retrying after the Nth failure (1-based): 5, 10, 20,
 * 40, ... capped at 6h. With the daily cron as the only guaranteed sweep,
 * every backoff shorter than 24h effectively means "next cron run" — the
 * shorter early values only matter when extra traffic-triggered attempts run.
 */
export function backoffMinutes(attempts: number): number {
  return Math.min(5 * 2 ** Math.max(0, attempts - 1), 360);
}

/**
 * Login lockout policy for password mode: each POST atomically consumes one
 * attempt (recordLoginAttempt) BEFORE the password check; a count beyond the
 * cap is rejected without comparing. Successful login clears the counter.
 */
export const LOGIN_WINDOW_MINUTES = 15;
export const LOGIN_MAX_ATTEMPTS = 10;
