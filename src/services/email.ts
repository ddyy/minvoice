import type { Bindings } from '../env';
import { getInvoice, getSettings, logInvoiceEvent, type InvoiceWithClient, type Settings } from '../db/queries';
import { formatCents } from '../lib/money';
import { effectiveProviderEnv } from '../lib/providers';

type Mail = {
  to: string;
  fromName: string;
  subject: string;
  text: string;
  html: string;
  replyTo?: string;
  attachments?: { filename: string; type: string; content: Uint8Array }[];
};

/**
 * Route a message through the provider chosen in Settings.
 * - 'cloudflare' (default): the Workers send_email binding
 * - 'resend': REST API; requires the RESEND_API_KEY secret and the from
 *   domain verified in the Resend dashboard
 */
async function deliver(env: Bindings, settings: Settings, m: Mail): Promise<void> {
  if (settings.email_provider === 'none') {
    throw new Error('Email sending is turned off in Settings.');
  }
  // Must be on a domain onboarded to CF Email Sending / verified at Resend.
  const fromAddress = settings.email_from.trim();
  if (!fromAddress) {
    throw new Error('No sending address configured — set "Email from address" in Settings.');
  }
  if (settings.email_provider === 'resend') {
    const resendKey = effectiveProviderEnv(env, settings).RESEND_API_KEY;
    if (!resendKey) {
      throw new Error('Email provider is set to Resend but no Resend API key is configured (Settings or secret)');
    }
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: `${m.fromName} <${fromAddress}>`,
        to: [m.to],
        subject: m.subject,
        text: m.text,
        html: m.html,
        ...(m.replyTo ? { reply_to: m.replyTo } : {}),
        ...(m.attachments?.length
          ? { attachments: m.attachments.map((a) => ({ filename: a.filename, content: toBase64(a.content) })) }
          : {}),
      }),
    });
    if (!res.ok) throw new Error(`Resend send failed: ${res.status} ${await res.text()}`);
    return;
  }

  if (!env.EMAIL) {
    throw new Error(
      'Cloudflare Email Sending binding (send_email) is not configured — switch Settings → Email provider to Resend, or add the binding in wrangler.jsonc.'
    );
  }
  await env.EMAIL.send({
    to: m.to,
    from: { email: fromAddress, name: m.fromName },
    ...(m.replyTo ? { replyTo: m.replyTo } : {}),
    subject: m.subject,
    text: m.text,
    html: m.html,
    ...(m.attachments?.length
      ? {
          attachments: m.attachments.map((a) => ({
            content: a.content,
            filename: a.filename,
            type: a.type,
            disposition: 'attachment' as const,
          })),
        }
      : {}),
  });
}

export function toBase64(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000; // avoid call-stack limits on large PDFs
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/**
 * Email the invoice to the client: pay link in the body, PDF attached.
 * Throws on failure — callers surface the error, they don't mark anything sent.
 */
export async function sendInvoiceEmail(
  env: Bindings,
  invoice: InvoiceWithClient,
  settings: Settings,
  pdfBytes: Uint8Array
): Promise<void> {
  if (!invoice.client_email) throw new Error('client has no email address');

  const businessName = settings.business_name || 'Minvoice';
  const payUrl = `${env.APP_BASE_URL}/pay/${invoice.public_token}`;
  const total = formatCents(invoice.total_cents, invoice.currency);
  // No due date -> no due wording at all; don't invent terms like "on receipt".
  const due = invoice.due_date ? `, due by ${invoice.due_date}` : '';

  await deliver(env, settings, {
    to: invoice.client_email,
    fromName: businessName,
    ...(settings.business_email ? { replyTo: settings.business_email } : {}),
    subject: invoice.subject
      ? `Invoice ${invoice.number} from ${businessName} — ${invoice.subject} — ${total}`
      : `Invoice ${invoice.number} from ${businessName} — ${total}`,
    text: [
      `Hi ${invoice.client_name},`,
      ``,
      `${businessName} has sent you invoice ${invoice.number} for ${total}${due}.`,
      ``,
      `View and pay online: ${payUrl}`,
      ``,
      `A PDF copy is attached.`,
    ].join('\n'),
    html: `
<div style="font-family: Georgia, 'Times New Roman', serif; max-width: 560px; margin: 0 auto; color: #1d1a15;">
  <div style="border-top: 3px solid #1e5b43; padding: 28px 4px 8px;">
    <h1 style="font-size: 22px; margin: 0 0 4px;">${escapeHtml(businessName)}</h1>
    <p style="color: #6b6459; margin: 0 0 24px; font-size: 14px;">Invoice ${escapeHtml(invoice.number)}${
      invoice.subject ? ` — ${escapeHtml(invoice.subject)}` : ''
    }</p>
    <p style="font-size: 15px; line-height: 1.6;">Hi ${escapeHtml(invoice.client_name)},</p>
    <p style="font-size: 15px; line-height: 1.6;">
      You have a new invoice for <strong>${total}</strong>${due}.
      A PDF copy is attached.
    </p>
    <p style="margin: 28px 0;">
      <a href="${payUrl}"
         style="background: #1e5b43; color: #fdfdf9; text-decoration: none; padding: 12px 24px; border-radius: 5px; font-family: -apple-system, sans-serif; font-size: 15px;">
        View &amp; pay invoice
      </a>
    </p>
    <p style="color: #756e61; font-size: 12.5px; line-height: 1.5;">
      Or copy this link: <a href="${payUrl}" style="color: #1e5b43;">${payUrl}</a>
    </p>
  </div>
</div>`,
    attachments: [
      {
        content: pdfBytes,
        filename: `${invoice.number}.pdf`,
        type: 'application/pdf',
      },
    ],
  });
}

/** Gentle overdue nudge: number/subject, amount, due date, pay link. No PDF —
 *  the original send carried it; reminders stay light. */
export async function sendReminderEmail(
  env: Bindings,
  settings: Settings,
  invoice: InvoiceWithClient,
  payUrl: string,
  reminderNumber: number
): Promise<void> {
  if (!invoice.client_email) throw new Error('client has no email address');
  const businessName = settings.business_name || 'Minvoice';
  const total = formatCents(invoice.total_cents, invoice.currency);
  const subjectPart = invoice.subject ? ` — ${invoice.subject}` : '';

  await deliver(env, settings, {
    to: invoice.client_email,
    fromName: businessName,
    ...(settings.business_email ? { replyTo: settings.business_email } : {}),
    subject: `Reminder: invoice ${invoice.number}${subjectPart} — ${total} was due ${invoice.due_date}`,
    text: [
      `Hi ${invoice.client_name},`,
      ``,
      `A friendly reminder that invoice ${invoice.number}${subjectPart} for ${total} was due on ${invoice.due_date}.`,
      ``,
      `View and pay online: ${payUrl}`,
      ``,
      `If you've already sent payment, please disregard this note. Thank you!`,
    ].join('\n'),
    html: `
<div style="font-family: Georgia, 'Times New Roman', serif; max-width: 560px; margin: 0 auto; color: #1d1a15;">
  <div style="border-top: 3px solid #1e5b43; padding: 28px 4px 8px;">
    <h1 style="font-size: 22px; margin: 0 0 4px;">${escapeHtml(businessName)}</h1>
    <p style="color: #6b6459; margin: 0 0 24px; font-size: 14px;">Payment reminder${
      reminderNumber > 1 ? ` (${reminderNumber})` : ''
    } — Invoice ${escapeHtml(invoice.number)}${escapeHtml(subjectPart)}</p>
    <p style="font-size: 15px; line-height: 1.6;">Hi ${escapeHtml(invoice.client_name)},</p>
    <p style="font-size: 15px; line-height: 1.6;">
      A friendly reminder that invoice ${escapeHtml(invoice.number)} for <strong>${total}</strong>
      was due on ${escapeHtml(invoice.due_date ?? '')}.
    </p>
    <p style="margin: 28px 0;">
      <a href="${payUrl}"
         style="background: #1e5b43; color: #fdfdf9; text-decoration: none; padding: 12px 24px; border-radius: 5px; font-family: -apple-system, sans-serif; font-size: 15px;">
        View &amp; pay invoice
      </a>
    </p>
    <p style="color: #756e61; font-size: 12.5px; line-height: 1.5;">
      If you've already sent payment, please disregard this note. Thank you!
    </p>
  </div>
</div>`,
  });
}

export type PaymentEmailInfo = { amountCents: number; currency: string; provider: string };

/**
 * Fire-and-forget side effects when a provider payment lands: receipt to the
 * client, "you got paid" note to the business email, both logged to History.
 * Call ONLY on the 'paid' transition result (exactly-once), inside waitUntil.
 * Failures are logged, never thrown — money is already in the books.
 */
export async function sendPaymentEmails(
  env: Bindings,
  db: D1Database,
  invoiceId: number,
  info: PaymentEmailInfo
): Promise<void> {
  const [invoice, settings] = await Promise.all([getInvoice(db, invoiceId), getSettings(db)]);
  if (!invoice) return;
  if (settings.email_provider === 'none') return; // emails deliberately off
  const amount = formatCents(info.amountCents, info.currency);
  const businessName = settings.business_name || 'Minvoice';
  const payUrl = `${env.APP_BASE_URL}/pay/${invoice.public_token}`;

  // Receipt to the client
  if (invoice.client_email) {
    try {
      await deliver(env, settings, {
        to: invoice.client_email,
        fromName: businessName,
        ...(settings.business_email ? { replyTo: settings.business_email } : {}),
        subject: `Payment received — Invoice ${invoice.number}`,
        text: [
          `Hi ${invoice.client_name},`,
          ``,
          `We received your payment of ${amount} for invoice ${invoice.number}. Thank you!`,
          ``,
          `View the paid invoice or download a PDF: ${payUrl}`,
        ].join('\n'),
        html: `
<div style="font-family: Georgia, 'Times New Roman', serif; max-width: 560px; margin: 0 auto; color: #1d1a15;">
  <div style="border-top: 3px solid #1e5b43; padding: 28px 4px 8px;">
    <h1 style="font-size: 22px; margin: 0 0 4px;">${escapeHtml(businessName)}</h1>
    <p style="color: #6b6459; margin: 0 0 24px; font-size: 14px;">Invoice ${escapeHtml(invoice.number)} — paid</p>
    <p style="font-size: 15px; line-height: 1.6;">Hi ${escapeHtml(invoice.client_name)},</p>
    <p style="font-size: 15px; line-height: 1.6;">
      We received your payment of <strong>${amount}</strong> for invoice ${escapeHtml(invoice.number)}. Thank you!
    </p>
    <p style="color: #756e61; font-size: 12.5px; line-height: 1.5;">
      View the paid invoice or download a PDF: <a href="${payUrl}" style="color: #1e5b43;">${payUrl}</a>
    </p>
  </div>
</div>`,
      });
      await logInvoiceEvent(db, invoiceId, 'emailed', `Receipt emailed to ${invoice.client_email}`);
    } catch (e) {
      console.error('receipt email failed', e);
    }
  }

  // "You got paid" to the business
  if (settings.business_email) {
    try {
      await deliver(env, settings, {
        to: settings.business_email,
        fromName: 'Minvoice',
        subject: `🎉 ${invoice.number} paid — ${amount} from ${invoice.client_name}`,
        text: [
          `${invoice.client_name} paid invoice ${invoice.number}: ${amount} via ${info.provider}.`,
          ``,
          `Invoice: ${env.APP_BASE_URL}/admin/invoices/${invoice.id}`,
        ].join('\n'),
        html: `
<div style="font-family: -apple-system, sans-serif; max-width: 560px; margin: 0 auto; color: #1d1a15;">
  <p style="font-size: 16px;">🎉 <strong>${escapeHtml(invoice.client_name)}</strong> paid invoice
    <strong>${escapeHtml(invoice.number)}</strong>: <strong>${amount}</strong> via ${escapeHtml(info.provider)}.</p>
  <p><a href="${env.APP_BASE_URL}/admin/invoices/${invoice.id}" style="color: #1e5b43;">Open the invoice</a></p>
</div>`,
      });
    } catch (e) {
      console.error('paid notification email failed', e);
    }
  }
}

/**
 * Alert the business email about an unhandled error. Best-effort: swallows
 * its own failures (an email outage must never cascade), and reads settings
 * defensively in case the DB itself is what broke.
 */
export async function sendErrorAlert(env: Bindings, db: D1Database, err: unknown, requestPath: string): Promise<void> {
  try {
    const settings = await getSettings(db);
    if (!settings.business_email || settings.email_provider === 'none') return;
    const message = err instanceof Error ? `${err.message}\n\n${err.stack ?? ''}` : String(err);
    await deliver(env, settings, {
      to: settings.business_email,
      fromName: 'Minvoice alerts',
      subject: `⚠️ Minvoice error on ${requestPath}`,
      text: `Unhandled error at ${requestPath}:\n\n${message.slice(0, 2000)}`,
      html: `<div style="font-family: -apple-system, sans-serif; max-width: 640px;">
  <p>⚠️ Unhandled error at <code>${escapeHtml(requestPath)}</code>:</p>
  <pre style="background:#f6f4ee;padding:12px;border-radius:6px;font-size:12px;white-space:pre-wrap;">${escapeHtml(
    message.slice(0, 2000)
  )}</pre>
</div>`,
    });
  } catch (alertErr) {
    console.error('error alert email failed', alertErr);
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
