import type { Bindings } from '../env';
import { enqueueReminder, getSettings, listOverdueForReminders } from '../db/queries';
import { todayInTz } from '../lib/dates';
import { daysBetween, parseSchedule, reminderDue } from '../lib/reminders';

/**
 * Daily cron entry point. Opt-in (Settings), no-op when email is off, and
 * idempotent: due reminders are enqueued to the email outbox deduplicated on
 * (invoice, reminderNumber), so re-running while one is pending is a no-op.
 * The outbox processor (same cron tick) delivers with retries and writes the
 * reminder history event only on actual delivery — the cadence counter
 * reflects emails that went out, not emails that were queued. Per-invoice
 * failures never block the rest.
 */
export async function sendOverdueReminders(env: Bindings): Promise<void> {
  const settings = await getSettings(env.DB);
  if (!settings.reminders_enabled || settings.email_provider === 'none') return;

  // No request in cron context: configured base URL, else the origin the
  // pay page last saw. Without either we can't build pay links — skip loudly.
  const base = ((env.APP_BASE_URL ?? '').trim() || settings.last_seen_origin).replace(/\/+$/, '');
  if (!base) {
    console.warn('reminders: no APP_BASE_URL and no traffic-derived origin yet — skipping run');
    return;
  }

  const today = todayInTz(settings.timezone);
  const schedule = parseSchedule(settings.reminder_schedule);
  const overdue = await listOverdueForReminders(env.DB, today);

  for (const inv of overdue) {
    const daysOverdue = daysBetween(inv.due_date!, today);
    const daysSinceLast = inv.last_reminder_at
      ? daysBetween(inv.last_reminder_at.slice(0, 10), today)
      : null;
    if (!reminderDue(daysOverdue, inv.reminders_sent, daysSinceLast, schedule)) continue;

    const n = inv.reminders_sent + 1;
    try {
      // Deduped on (invoice, n): while reminder n is still undelivered in the
      // outbox, tomorrow's run re-derives "n is due" and this becomes a no-op.
      await enqueueReminder(env.DB, { invoiceId: inv.id, payUrl: `${base}/pay/${inv.public_token}`, reminderNumber: n });
    } catch (e) {
      console.error(`reminder enqueue failed for invoice ${inv.number}`, e);
    }
  }
}
