import Stripe from 'stripe';
import type { Bindings } from '../env';
import type { InvoiceWithClient } from '../db/queries';

export function stripeClient(env: Bindings): Stripe {
  return new Stripe(env.STRIPE_SECRET_KEY ?? '', {
    // Workers has no Node http; the fetch client is the supported path.
    httpClient: Stripe.createFetchHttpClient(),
  });
}

/** One line item for the invoice total — per-item rows would fight our own tax math. */
export async function createCheckoutSession(
  env: Bindings,
  invoice: InvoiceWithClient,
  businessName?: string
): Promise<string> {
  const stripe = stripeClient(env);
  const payUrl = `${env.APP_BASE_URL}/pay/${invoice.public_token}`;
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    client_reference_id: String(invoice.id),
    // Deliberately NOT passing customer_email: Stripe locks that field when set,
    // and the payer (e.g. a bookkeeper) must be able to enter their own address.
    metadata: { invoice_id: String(invoice.id), invoice_number: invoice.number },
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: invoice.currency.toLowerCase(),
          unit_amount: invoice.total_cents,
          product_data: {
            name: businessName ? `${businessName} — Invoice ${invoice.number}` : `Invoice ${invoice.number}`,
          },
        },
      },
    ],
    success_url: `${payUrl}?paid=1`,
    cancel_url: payUrl,
  });
  if (!session.url) throw new Error('Stripe did not return a checkout URL');
  return session.url;
}

/**
 * Verify and parse a webhook. MUST use constructEventAsync on Workers —
 * the sync variant calls Node's crypto.createHmac and throws.
 */
export async function verifyStripeEvent(env: Bindings, rawBody: string, signature: string): Promise<Stripe.Event> {
  const stripe = stripeClient(env);
  if (!env.STRIPE_WEBHOOK_SECRET) throw new Error('no webhook secret configured');
  return stripe.webhooks.constructEventAsync(
    rawBody,
    signature,
    env.STRIPE_WEBHOOK_SECRET,
    undefined,
    Stripe.createSubtleCryptoProvider()
  );
}
