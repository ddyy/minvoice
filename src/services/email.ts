import type { Bindings } from '../env';
import { getInvoice, getLogo, getSettings, logInvoiceEvent, type InvoiceItem, type InvoiceWithClient, type Settings } from '../db/queries';
import { computeTotals, formatCents } from '../lib/money';
import { addDaysISO, todayInTz } from '../lib/dates';
import { generateInvoicePdf } from './pdf';
import { formatCentsTag, formatDateTag, getStrings, resolveLocale } from '../lib/strings';
import { accentForeground, safeAccent } from '../lib/color';
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
  const tag = resolveLocale(settings.locale, invoice.client_locale);
  const t = getStrings(tag);
  const accent = safeAccent(settings.accent_color);
  const accentFg = accentForeground(accent);
  const total = formatCentsTag(invoice.total_cents, invoice.currency, tag);
  // No due date -> no due wording at all; don't invent terms like "on receipt".
  const dueDate = invoice.due_date ? formatDateTag(invoice.due_date, tag) : null;

  await deliver(env, settings, {
    to: invoice.client_email,
    fromName: businessName,
    ...(settings.business_email ? { replyTo: settings.business_email } : {}),
    subject: t.emailInvoiceSubject(invoice.number, businessName, invoice.subject, total),
    text: [
      t.greeting(invoice.client_name),
      ``,
      t.emailInvoiceBody(businessName, invoice.number, total, dueDate),
      ``,
      `${t.viewAndPay} ${payUrl}`,
      ``,
      t.pdfAttached,
    ].join('\n'),
    html: `
<div style="font-family: Georgia, 'Times New Roman', serif; max-width: 560px; margin: 0 auto; color: #1d1a15;">
  <div style="border-top: 3px solid ${accent}; padding: 28px 4px 8px;">
    <h1 style="font-size: 22px; margin: 0 0 4px;">${escapeHtml(businessName)}</h1>
    <p style="color: #6b6459; margin: 0 0 24px; font-size: 14px;">${escapeHtml(t.invoice)} ${escapeHtml(invoice.number)}${
      invoice.subject ? ` — ${escapeHtml(invoice.subject)}` : ''
    }</p>
    <p style="font-size: 15px; line-height: 1.6;">${escapeHtml(t.greeting(invoice.client_name))}</p>
    <p style="font-size: 15px; line-height: 1.6;">
      ${escapeHtml(t.emailInvoiceBody(businessName, invoice.number, total, dueDate))}
      ${escapeHtml(t.pdfAttached)}
    </p>
    <p style="margin: 28px 0;">
      <a href="${payUrl}"
         style="background: ${accent}; color: ${accentFg}; text-decoration: none; padding: 12px 24px; border-radius: 5px; font-family: -apple-system, sans-serif; font-size: 15px;">
        ${escapeHtml(t.viewAndPayButton)}
      </a>
    </p>
    <p style="color: #756e61; font-size: 12.5px; line-height: 1.5;">
      ${escapeHtml(t.orCopyLink)} <a href="${payUrl}" style="color: ${accent};">${payUrl}</a>
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
  const tag = resolveLocale(settings.locale, invoice.client_locale);
  const t = getStrings(tag);
  const accent = safeAccent(settings.accent_color);
  const accentFg = accentForeground(accent);
  const total = formatCentsTag(invoice.total_cents, invoice.currency, tag);
  const dueDate = formatDateTag(invoice.due_date ?? '', tag);

  await deliver(env, settings, {
    to: invoice.client_email,
    fromName: businessName,
    ...(settings.business_email ? { replyTo: settings.business_email } : {}),
    subject: t.reminderSubject(invoice.number, invoice.subject, total, dueDate),
    text: [
      t.greeting(invoice.client_name),
      ``,
      t.reminderBody(invoice.number, invoice.subject, total, dueDate),
      ``,
      `${t.viewAndPay} ${payUrl}`,
      ``,
      t.reminderDisregard,
    ].join('\n'),
    html: `
<div style="font-family: Georgia, 'Times New Roman', serif; max-width: 560px; margin: 0 auto; color: #1d1a15;">
  <div style="border-top: 3px solid ${accent}; padding: 28px 4px 8px;">
    <h1 style="font-size: 22px; margin: 0 0 4px;">${escapeHtml(businessName)}</h1>
    <p style="color: #6b6459; margin: 0 0 24px; font-size: 14px;">${escapeHtml(t.reminderTitle)}${
      reminderNumber > 1 ? ` (${reminderNumber})` : ''
    } — ${escapeHtml(t.invoice)} ${escapeHtml(invoice.number)}${invoice.subject ? ` — ${escapeHtml(invoice.subject)}` : ''}</p>
    <p style="font-size: 15px; line-height: 1.6;">${escapeHtml(t.greeting(invoice.client_name))}</p>
    <p style="font-size: 15px; line-height: 1.6;">
      ${escapeHtml(t.reminderBody(invoice.number, invoice.subject, total, dueDate))}
    </p>
    <p style="margin: 28px 0;">
      <a href="${payUrl}"
         style="background: ${accent}; color: ${accentFg}; text-decoration: none; padding: 12px 24px; border-radius: 5px; font-family: -apple-system, sans-serif; font-size: 15px;">
        ${escapeHtml(t.viewAndPayButton)}
      </a>
    </p>
    <p style="color: #756e61; font-size: 12.5px; line-height: 1.5;">
      ${escapeHtml(t.reminderDisregard)}
    </p>
  </div>
</div>`,
  });
}

export type PaymentEmailInfo = { amountCents: number; currency: string; provider: string };

/**
 * Receipt to the client after a provider payment lands. Delivered through the
 * email_outbox (enqueued in the same transaction as the paid transition), so
 * semantics are at-least-once with retries — a failure here THROWS and the
 * outbox processor records it for a later attempt. No-recipient and
 * emails-off configurations count as delivered.
 */
export async function sendPaymentReceipt(
  env: Bindings,
  db: D1Database,
  invoiceId: number,
  info: PaymentEmailInfo
): Promise<void> {
  const [invoice, settings] = await Promise.all([getInvoice(db, invoiceId), getSettings(db)]);
  if (!invoice) return;
  if (settings.email_provider === 'none') return; // emails deliberately off
  const tag = resolveLocale(settings.locale, invoice.client_locale);
  const t = getStrings(tag);
  const accent = safeAccent(settings.accent_color);
  const amount = formatCentsTag(info.amountCents, info.currency, tag);
  const businessName = settings.business_name || 'Minvoice';
  const payUrl = `${env.APP_BASE_URL}/pay/${invoice.public_token}`;

  if (invoice.client_email) {
    await deliver(env, settings, {
        to: invoice.client_email,
        fromName: businessName,
        ...(settings.business_email ? { replyTo: settings.business_email } : {}),
        subject: t.receiptSubject(invoice.number),
        text: [
          t.greeting(invoice.client_name),
          ``,
          t.receiptBody(amount, invoice.number),
          ``,
          `${t.receiptView} ${payUrl}`,
        ].join('\n'),
        html: `
<div style="font-family: Georgia, 'Times New Roman', serif; max-width: 560px; margin: 0 auto; color: #1d1a15;">
  <div style="border-top: 3px solid ${accent}; padding: 28px 4px 8px;">
    <h1 style="font-size: 22px; margin: 0 0 4px;">${escapeHtml(businessName)}</h1>
    <p style="color: #6b6459; margin: 0 0 24px; font-size: 14px;">${escapeHtml(t.invoice)} ${escapeHtml(invoice.number)} — ${escapeHtml(t.paid.toLocaleLowerCase(tag))}</p>
    <p style="font-size: 15px; line-height: 1.6;">${escapeHtml(t.greeting(invoice.client_name))}</p>
    <p style="font-size: 15px; line-height: 1.6;">
      ${escapeHtml(t.receiptBody(amount, invoice.number))}
    </p>
    <p style="color: #756e61; font-size: 12.5px; line-height: 1.5;">
      ${escapeHtml(t.receiptView)} <a href="${payUrl}" style="color: ${accent};">${payUrl}</a>
    </p>
  </div>
</div>`,
    });
    await logInvoiceEvent(db, invoiceId, 'emailed', `Receipt emailed to ${invoice.client_email}`);
  }
}

/**
 * "You got paid" note to the business email. Same outbox delivery contract as
 * sendPaymentReceipt: throws on failure, no-ops count as delivered.
 */
export async function sendPaidNotice(
  env: Bindings,
  db: D1Database,
  invoiceId: number,
  info: PaymentEmailInfo
): Promise<void> {
  const [invoice, settings] = await Promise.all([getInvoice(db, invoiceId), getSettings(db)]);
  if (!invoice) return;
  if (settings.email_provider === 'none') return;
  const accent = safeAccent(settings.accent_color);
  const amount = formatCents(info.amountCents, info.currency);

  if (settings.business_email) {
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
  <p><a href="${env.APP_BASE_URL}/admin/invoices/${invoice.id}" style="color: ${accent};">Open the invoice</a></p>
</div>`,
    });
  }
}

/**
 * Settings "Send test email" button: sends a SAMPLE INVOICE through the real
 * template pipeline — current locale, accent color, currency, and the actual
 * PDF (logo and fonts included) attached — addressed to the business email.
 * The sample invoice is built in memory and never touches the database, and
 * the number is unmistakably fake. Throws with deliver()'s descriptive
 * errors so the settings page can show exactly what's wrong.
 */
export async function sendTestEmail(env: Bindings, db: D1Database): Promise<string> {
  const settings = await getSettings(db);
  if (!settings.business_email) {
    throw new Error('Set a business email first — the test message is sent to it.');
  }
  const today = todayInTz(settings.timezone);
  const rate = settings.default_rate_cents || 12500;
  const items: InvoiceItem[] = [
    {
      id: 1,
      invoice_id: 0,
      position: 0,
      description: 'Sample line item — design work',
      quantity: 4,
      unit_price_cents: rate,
      amount_cents: 4 * rate,
    },
    { id: 2, invoice_id: 0, position: 1, description: 'Another sample item', quantity: 1, unit_price_cents: rate, amount_cents: rate },
  ];
  const totals = computeTotals(items, settings.tax_rate_bps);
  const invoice: InvoiceWithClient = {
    id: 0,
    number: `${settings.invoice_prefix || 'INV-'}SAMPLE`,
    client_id: 0,
    status: 'sent',
    currency: settings.currency,
    issue_date: today,
    due_date: settings.payment_terms_days ? addDaysISO(today, settings.payment_terms_days) : null,
    subject: 'Test email — sample invoice',
    notes: 'This is a sample invoice sent from Settings to preview your email and PDF. The pay link is not real.',
    tax_rate_bps: settings.tax_rate_bps,
    ...totals,
    public_token: 'sample',
    paypal_order_id: null,
    sent_at: null,
    paid_at: null,
    created_at: '',
    updated_at: '',
    client_name: 'Sample Client',
    client_email: settings.business_email,
    client_locale: null,
  };
  const pdf = await generateInvoicePdf(
    invoice,
    items,
    settings,
    `${env.APP_BASE_URL}/pay/sample`,
    env.ASSETS,
    await getLogo(db)
  );
  await sendInvoiceEmail(env, invoice, settings, pdf);
  return settings.business_email;
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
