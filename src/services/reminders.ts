import type { Bindings } from '../env';
import { getSettings, listOverdueForReminders, logInvoiceEvent } from '../db/queries';
import { todayInTz } from '../lib/dates';
import { daysBetween, parseSchedule, reminderDue } from '../lib/reminders';
import { sendReminderEmail } from './email';

/**
 * Daily cron entry point. Opt-in (Settings), no-op when email is off, and
 * idempotent: reminder history lives in invoice_events, so re-running the
 * same day sends nothing new. Per-invoice failures never block the rest.
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
      await sendReminderEmail(env, settings, inv, `${base}/pay/${inv.public_token}`, n);
      // Logged only on success — the cadence counter must reflect reality
      await logInvoiceEvent(
        env.DB,
        inv.id,
        'reminder',
        `Reminder ${n} of ${schedule.length} emailed to ${inv.client_email} — ${daysOverdue} days overdue`
      );
    } catch (e) {
      console.error(`reminder failed for invoice ${inv.number}`, e);
    }
  }
}
