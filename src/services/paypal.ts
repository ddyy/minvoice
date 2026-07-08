import type { Bindings } from '../env';
import type { Invoice } from '../db/queries';

// Per-isolate OAuth token cache, keyed by client id — credentials can come
// from env or Settings and may change between requests. PayPal tokens last
// ~9h; isolate recycling just means an occasional extra token call.
let cached: { cacheKey: string; token: string; exp: number } | null = null;

function apiBase(env: Bindings): string {
  return env.PAYPAL_API_BASE || 'https://api-m.paypal.com';
}

export async function getAccessToken(env: Bindings): Promise<string> {
  if (!env.PAYPAL_CLIENT_ID || !env.PAYPAL_CLIENT_SECRET) {
    throw new Error('PayPal credentials are not configured');
  }
  const cacheKey = `${env.PAYPAL_CLIENT_ID}@${apiBase(env)}`;
  if (cached && cached.cacheKey === cacheKey && Date.now() < cached.exp - 60_000) {
    return cached.token;
  }
  const res = await fetch(`${apiBase(env)}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${btoa(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`)}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error(`PayPal oauth failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { access_token: string; expires_in: number };
  cached = { cacheKey, token: data.access_token, exp: Date.now() + data.expires_in * 1000 };
  return cached.token;
}

async function paypalFetch(env: Bindings, path: string, init: RequestInit & { idempotencyKey?: string } = {}) {
  const token = await getAccessToken(env);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    ...(init.headers as Record<string, string>),
  };
  if (init.idempotencyKey) headers['PayPal-Request-Id'] = init.idempotencyKey;
  const res = await fetch(`${apiBase(env)}${path}`, { ...init, headers });
  if (!res.ok) throw new Error(`PayPal ${path} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

/** Create an order and return { orderId, approveUrl } for the payer redirect. */
export async function createOrder(env: Bindings, invoice: Invoice): Promise<{ orderId: string; approveUrl: string }> {
  const payUrl = `${env.APP_BASE_URL}/pay/${invoice.public_token}`;
  const order = (await paypalFetch(env, '/v2/checkout/orders', {
    method: 'POST',
    idempotencyKey: `minvoice-order-${invoice.id}-${invoice.total_cents}`,
    body: JSON.stringify({
      intent: 'CAPTURE',
      purchase_units: [
        {
          reference_id: String(invoice.id),
          custom_id: String(invoice.id),
          invoice_id: invoice.number,
          amount: {
            currency_code: invoice.currency,
            value: (invoice.total_cents / 100).toFixed(2),
          },
        },
      ],
      payment_source: {
        paypal: {
          experience_context: {
            user_action: 'PAY_NOW',
            shipping_preference: 'NO_SHIPPING',
            return_url: `${payUrl}/paypal/return`,
            cancel_url: payUrl,
          },
        },
      },
    }),
  })) as { id: string; links: Array<{ rel: string; href: string }> };

  const approve = order.links.find((l) => l.rel === 'payer-action' || l.rel === 'approve');
  if (!approve) throw new Error('PayPal order has no approval link');
  return { orderId: order.id, approveUrl: approve.href };
}

export type CaptureResult = { captureId: string; status: string; amountCents: number; currency: string };

export async function captureOrder(env: Bindings, orderId: string): Promise<CaptureResult> {
  const data = (await paypalFetch(env, `/v2/checkout/orders/${orderId}/capture`, {
    method: 'POST',
    idempotencyKey: `minvoice-capture-${orderId}`,
    body: JSON.stringify({}),
  })) as {
    status: string;
    purchase_units: Array<{ payments?: { captures?: Array<{ id: string; status: string; amount: { value: string; currency_code: string } }> } }>;
  };
  const capture = data.purchase_units?.[0]?.payments?.captures?.[0];
  if (!capture) throw new Error(`PayPal capture returned no capture object (status ${data.status})`);
  return {
    captureId: capture.id,
    status: capture.status,
    amountCents: Math.round(parseFloat(capture.amount.value) * 100),
    currency: capture.amount.currency_code,
  };
}

/**
 * PayPal has no local HMAC verification usable on Workers; the supported
 * pattern is posting the delivery back to their verify endpoint.
 */
export async function verifyWebhook(env: Bindings, headers: Headers, rawBody: string): Promise<boolean> {
  const required = [
    'paypal-auth-algo',
    'paypal-cert-url',
    'paypal-transmission-id',
    'paypal-transmission-sig',
    'paypal-transmission-time',
  ];
  if (required.some((h) => !headers.get(h))) return false;
  const result = (await paypalFetch(env, '/v1/notifications/verify-webhook-signature', {
    method: 'POST',
    body: JSON.stringify({
      auth_algo: headers.get('paypal-auth-algo'),
      cert_url: headers.get('paypal-cert-url'),
      transmission_id: headers.get('paypal-transmission-id'),
      transmission_sig: headers.get('paypal-transmission-sig'),
      transmission_time: headers.get('paypal-transmission-time'),
      webhook_id: env.PAYPAL_WEBHOOK_ID,
      webhook_event: JSON.parse(rawBody),
    }),
  })) as { verification_status: string };
  return result.verification_status === 'SUCCESS';
}
