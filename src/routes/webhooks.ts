import { Hono } from 'hono';
import type Stripe from 'stripe';
import type { AppEnv } from '../env';
import { getInvoiceByPaypalOrderId, getSettings, markInvoicePaidFromWebhook } from '../db/queries';
import { effectiveProviderEnv } from '../lib/providers';
import { verifyStripeEvent } from '../services/stripe';
import { verifyWebhook as verifyPaypalWebhook } from '../services/paypal';
import { sendPaymentEmails } from '../services/email';

export const webhooks = new Hono<AppEnv>();

// Contract with providers: 400 only for signature/verification failures (they
// retry those); 200 for anything we consciously ignore or already processed.

webhooks.post('/stripe', async (c) => {
  const signature = c.req.header('stripe-signature');
  if (!signature) return c.text('missing signature', 400);
  const rawBody = await c.req.text(); // read exactly once, before any parsing

  let event: Stripe.Event;
  try {
    const settings = await getSettings(c.env.DB);
    event = await verifyStripeEvent(effectiveProviderEnv(c.env, settings), rawBody, signature);
  } catch {
    return c.text('invalid signature', 400);
  }

  if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
    const session = event.data.object as Stripe.Checkout.Session;
    // completed fires even for delayed methods still pending — only paid counts.
    if (session.payment_status !== 'paid') return c.text('ignored: not paid', 200);
    // Foreign events (other products on the account, stripe trigger fixtures)
    // have no ref — Number(null) is 0, so require a positive id, not just an
    // integer, or the payment INSERT dies on the FK constraint.
    const invoiceId = Number(session.metadata?.invoice_id ?? session.client_reference_id);
    if (!Number.isInteger(invoiceId) || invoiceId <= 0) return c.text('ignored: no invoice ref', 200);

    const result = await markInvoicePaidFromWebhook(c.env.DB, {
      provider: 'stripe',
      eventId: event.id,
      eventType: event.type,
      payload: rawBody,
      invoiceId,
      providerRef: session.id,
      amountCents: session.amount_total ?? 0,
      currency: (session.currency ?? '').toUpperCase(),
      paymentIntent: typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id,
    });
    if (result === 'paid') {
      // After the 200 — Stripe shouldn't wait on our emails
      c.executionCtx.waitUntil(
        sendPaymentEmails(c.env, c.env.DB, invoiceId, {
          amountCents: session.amount_total ?? 0,
          currency: (session.currency ?? 'USD').toUpperCase(),
          provider: 'Stripe',
        }).catch((e) => console.error('payment emails failed', e))
      );
    }
  }
  return c.text('ok', 200);
});

webhooks.post('/paypal', async (c) => {
  const rawBody = await c.req.text();

  let verified = false;
  try {
    const settings = await getSettings(c.env.DB);
    verified = await verifyPaypalWebhook(effectiveProviderEnv(c.env, settings), c.req.raw.headers, rawBody);
  } catch {
    verified = false;
  }
  if (!verified) return c.text('verification failed', 400);

  const event = JSON.parse(rawBody) as {
    id: string;
    event_type: string;
    resource?: {
      id?: string;
      status?: string;
      custom_id?: string;
      amount?: { value: string; currency_code: string };
      supplementary_data?: { related_ids?: { order_id?: string } };
    };
  };

  if (event.event_type === 'PAYMENT.CAPTURE.COMPLETED' && event.resource) {
    const r = event.resource;
    // Correlate: custom_id carries our invoice id; fall back to the stored order id.
    let invoiceId = Number(r.custom_id);
    if (!Number.isInteger(invoiceId) || invoiceId <= 0) {
      const orderId = r.supplementary_data?.related_ids?.order_id;
      const inv = orderId ? await getInvoiceByPaypalOrderId(c.env.DB, orderId) : null;
      if (!inv) return c.text('ignored: no invoice ref', 200);
      invoiceId = inv.id;
    }

    const amountCents = r.amount ? Math.round(parseFloat(r.amount.value) * 100) : 0;
    const currency = r.amount?.currency_code ?? 'USD';
    const result = await markInvoicePaidFromWebhook(c.env.DB, {
      provider: 'paypal',
      eventId: event.id,
      eventType: event.event_type,
      payload: rawBody,
      invoiceId,
      providerRef: r.id ?? `paypal-${event.id}`,
      amountCents,
      currency,
    });
    if (result === 'paid') {
      c.executionCtx.waitUntil(
        sendPaymentEmails(c.env, c.env.DB, invoiceId, { amountCents, currency, provider: 'PayPal' }).catch((e) =>
          console.error('payment emails failed', e)
        )
      );
    }
  }
  return c.text('ok', 200);
});
