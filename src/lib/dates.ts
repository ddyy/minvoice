/** Today's date (YYYY-MM-DD) in an IANA time zone. en-CA gives ISO format. */
export function todayInTz(tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
}

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Add N days to a YYYY-MM-DD date string (calendar math, DST-proof via UTC). */
export function addDaysISO(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Render a stored UTC timestamp ("YYYY-MM-DD HH:MM:SS") in the business time
 * zone as "YYYY-MM-DD HH:MM". Date-only values (backdates) pass through.
 */
export function formatTimestamp(at: string, tz: string): string {
  if (at.length <= 10) return at;
  const d = new Date(at.replace(' ', 'T') + 'Z');
  if (Number.isNaN(d.getTime())) return at;
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(d);
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d);
  return `${date} ${time}`;
}
