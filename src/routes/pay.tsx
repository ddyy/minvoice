import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppEnv } from '../env';
import {
  getInvoiceByToken,
  getInvoiceItems,
  getLogo,
  getSettings,
  markInvoicePaidFromWebhook,
  recordInvoiceView,
  setPaypalOrderId,
  updateLastSeenOrigin,
} from '../db/queries';
import { isLocalRequest } from '../lib/admin-auth';
import { createCheckoutSession } from '../services/stripe';
import { captureOrder, createOrder } from '../services/paypal';
import { generateInvoicePdf, pdfResponse } from '../services/pdf';
import { processEmailOutbox } from '../services/outbox';
import { effectiveProviderEnv, providerAvailability } from '../lib/providers';
import { DraftHold, PublicInvoice } from '../views/pay';
import { PrintInvoice } from '../views/print';

export const pay = new Hono<AppEnv>();

// Pay links are unguessable capability URLs — keep them out of indexes and referrers.
pay.use('*', async (c, next) => {
  await next();
  c.res.headers.set('X-Robots-Tag', 'noindex, nofollow');
  c.res.headers.set('Referrer-Policy', 'no-referrer');
});

const BOT_UA = /bot|crawl|spider|scan|preview|fetch|monitor|probe|curl|wget|python|java|headless|lighthouse|slurp/i;
// Networks that email scanners open links from (SafeLinks etc.). Deliberately
// NOT Cloudflare/Apple/Akamai/Fastly — iCloud Private Relay egresses there.
const DATACENTER_ASN = /microsoft|azure|amazon|aws|google llc|hetzner|digitalocean|ovh|linode|vultr|oracle|alibaba/i;

/**
 * A view worth recording: a human other than the admin. The CF_Authorization
 * cookie is domain-scoped, so the admin's own browser sends it to /pay/* too —
 * its presence means "this is the admin". (Trivially spoofable to opt out of
 * tracking; that's fine, it's analytics, not security.)
 */
function classifyView(c: Context<AppEnv>): { record: boolean; geo: string | null } {
  const cookie = c.req.header('Cookie') ?? '';
  const ua = c.req.header('User-Agent') ?? '';
  const cf = (c.req.raw as { cf?: { city?: string; region?: string; country?: string; asOrganization?: string } }).cf;
  const record =
    !cookie.includes('CF_Authorization=') && !!ua && !BOT_UA.test(ua) && !DATACENTER_ASN.test(cf?.asOrganization ?? '');
  const geo = [cf?.city, cf?.region, cf?.country].filter(Boolean).join(', ') || null;
  return { record, geo };
}

pay.get('/:token', async (c) => {
  const invoice = await getInvoiceByToken(c.env.DB, c.req.param('token'));
  if (!invoice) return c.notFound();
  // Drafts aren't shareable yet — any draft view is the admin previewing.
  const view = classifyView(c);
  if (view.record && invoice.status !== 'draft') {
    c.executionCtx.waitUntil(
      recordInvoiceView(c.env.DB, invoice.id, view.geo).catch((e) => console.error('view tracking failed', e))
    );
  }
  const [items, settings] = await Promise.all([
    getInvoiceItems(c.env.DB, invoice.id),
    getSettings(c.env.DB),
  ]);
  // Keep the traffic-derived origin fresh for cron-built pay links (writes
  // only when it changes — effectively once per deployment hostname).
  const origin = new URL(c.req.url).origin;
  if (origin !== settings.last_seen_origin && !isLocalRequest(c.req.raw)) {
    c.executionCtx.waitUntil(updateLastSeenOrigin(c.env.DB, origin));
  }
  if (invoice.status === 'draft') {
    return c.html(<DraftHold invoice={invoice} settings={settings} />);
  }
  return c.html(
    <PublicInvoice
      invoice={invoice}
      items={items}
      settings={settings}
      justPaid={c.req.query('paid') === '1'}
      canceled={c.req.query('canceled') === '1'}
      providers={await providerAvailability(c.env, settings)}
    />
  );
});

pay.get('/:token/print', async (c) => {
  const invoice = await getInvoiceByToken(c.env.DB, c.req.param('token'));
  if (!invoice) return c.notFound();
  const [items, settings] = await Promise.all([
    getInvoiceItems(c.env.DB, invoice.id),
    getSettings(c.env.DB),
  ]);
  return c.html(
    <PrintInvoice
      invoice={invoice}
      items={items}
      settings={settings}
      payUrl={`${c.env.APP_BASE_URL}/pay/${invoice.public_token}`}
    />
  );
});

pay.get('/:token/pdf', async (c) => {
  const invoice = await getInvoiceByToken(c.env.DB, c.req.param('token'));
  if (!invoice) return c.notFound();
  const [items, settings, logo] = await Promise.all([
    getInvoiceItems(c.env.DB, invoice.id),
    getSettings(c.env.DB),
    getLogo(c.env.DB),
  ]);
  return pdfResponse(
    await generateInvoicePdf(invoice, items, settings, `${c.env.APP_BASE_URL}/pay/${invoice.public_token}`, c.env.ASSETS, logo),
    `${invoice.number}.pdf`
  );
});

pay.post('/:token/stripe', async (c) => {
  const invoice = await getInvoiceByToken(c.env.DB, c.req.param('token'));
  if (!invoice) return c.notFound();
  const settings = await getSettings(c.env.DB);
  if (!(await providerAvailability(c.env, settings)).stripe) return c.redirect(`/pay/${invoice.public_token}`, 303);
  if (invoice.status === 'paid' || invoice.status === 'void' || invoice.total_cents <= 0) {
    return c.redirect(`/pay/${invoice.public_token}`, 303);
  }
  const url = await createCheckoutSession(
    await effectiveProviderEnv(c.env, settings),
    invoice,
    settings.business_name || undefined
  );
  return c.redirect(url, 303);
});

pay.post('/:token/paypal', async (c) => {
  const invoice = await getInvoiceByToken(c.env.DB, c.req.param('token'));
  if (!invoice) return c.notFound();
  const settings = await getSettings(c.env.DB);
  if (!(await providerAvailability(c.env, settings)).paypal) {
    return c.redirect(`/pay/${invoice.public_token}`, 303);
  }
  if (invoice.status === 'paid' || invoice.status === 'void' || invoice.total_cents <= 0) {
    return c.redirect(`/pay/${invoice.public_token}`, 303);
  }
  const { orderId, approveUrl } = await createOrder(await effectiveProviderEnv(c.env, settings), invoice);
  await setPaypalOrderId(c.env.DB, invoice.id, orderId);
  return c.redirect(approveUrl, 303);
});

// PayPal sends the payer back with ?token=<orderId>. Capture here for a snappy
// confirmation; the webhook remains the source of truth, and the UNIQUE
// (provider, provider_ref) constraint dedupes whichever lands second.
pay.get('/:token/paypal/return', async (c) => {
  const invoice = await getInvoiceByToken(c.env.DB, c.req.param('token'));
  if (!invoice) return c.notFound();
  const orderId = c.req.query('token');
  const payUrl = `/pay/${invoice.public_token}`;
  if (!orderId || orderId !== invoice.paypal_order_id) return c.redirect(payUrl, 303);
  if (invoice.status === 'paid') return c.redirect(`${payUrl}?paid=1`, 303);

  try {
    const settings = await getSettings(c.env.DB);
    const capture = await captureOrder(await effectiveProviderEnv(c.env, settings), orderId);
    if (capture.status === 'COMPLETED') {
      const result = await markInvoicePaidFromWebhook(c.env.DB, {
        provider: 'paypal',
        eventId: `capture-return-${capture.captureId}`,
        eventType: 'capture.on_return',
        payload: JSON.stringify(capture),
        invoiceId: invoice.id,
        providerRef: capture.captureId,
        amountCents: capture.amountCents,
        currency: capture.currency,
      });
      // 'paid' fires here or on the webhook, never both — the status guard
      // means only one path performs the transition.
      if (result === 'paid') {
        c.executionCtx.waitUntil(processEmailOutbox(c.env).catch((e) => console.error('outbox drain failed', e)));
      }
      return c.redirect(`${payUrl}?paid=1`, 303);
    }
  } catch (e) {
    console.error('paypal capture on return failed', e);
  }
  return c.redirect(payUrl, 303);
});
