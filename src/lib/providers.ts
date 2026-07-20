import type { Bindings } from '../env';
import type { Settings } from '../db/queries';
import { setSecretSetting, SECRET_SETTINGS_COLUMNS } from '../db/queries';
import { secretConfigured } from './config';
import { box, isBoxed, unbox, validMasterKey } from './secretbox';

/**
 * Payment/email credentials can live in two places:
 * - wrangler secrets (encrypted at rest) — the hardened path, always wins
 * - Settings columns in D1 — the zero-CLI convenience path, envelope-encrypted
 *   with SETTINGS_MASTER_KEY when that secret exists (see lib/secretbox.ts)
 * This resolves the effective value per field and exposes availability
 * (toggle AND credentials) for UI gating.
 */

async function pick(masterKey: string | undefined, secret: string | undefined, stored: string | undefined): Promise<string | undefined> {
  if (secretConfigured(secret)) return secret;
  const opened = await unbox(masterKey, (stored ?? '').trim());
  if (opened === undefined) return undefined; // boxed but master key absent/wrong
  return secretConfigured(opened) ? opened : undefined;
}

export const PAYPAL_LIVE_BASE = 'https://api-m.paypal.com';
export const PAYPAL_SANDBOX_BASE = 'https://api-m.sandbox.paypal.com';

/**
 * Currencies PayPal accepts for payments, minus HUF/JPY/TWD (PayPal rejects
 * decimal amounts for those; the app stores cents). Both providers are
 * currency-gated in providerAvailability — see STRIPE_CURRENCIES below.
 */
export const PAYPAL_CURRENCIES = new Set([
  'AUD', 'BRL', 'CAD', 'CHF', 'CNY', 'CZK', 'DKK', 'EUR', 'GBP', 'HKD', 'ILS',
  'MXN', 'MYR', 'NOK', 'NZD', 'PHP', 'PLN', 'SEK', 'SGD', 'THB', 'USD',
]);

/**
 * The APP-COMPATIBLE subset of Stripe's presentment currencies
 * (docs.stripe.com/currencies, 2026-07) — not a verbatim snapshot. Intl knows
 * currencies Stripe can't charge (GHS, BTN, MRU, STN, TMT, VES, …), so the
 * card button is gated the same way as PayPal.
 *
 * Deliberate omissions when refreshing from Stripe's docs:
 * - BHD, JOD, KWD, OMR, TND: Stripe supports them, but they're three-decimal
 *   currencies (1000 fils/dinar) and the app's integer-cents model can't
 *   represent them — do NOT re-add.
 * - Zero-decimal currencies stay listed here for fidelity but are already
 *   excluded app-wide by isSupportedCurrency (lib/money.ts).
 */
export const STRIPE_CURRENCIES = new Set([
  'AED', 'AFN', 'ALL', 'AMD', 'ANG', 'AOA', 'ARS', 'AUD', 'AWG', 'AZN', 'BAM',
  'BBD', 'BDT', 'BIF', 'BMD', 'BND', 'BOB', 'BRL', 'BSD', 'BWP', 'BYN', 'BZD',
  'CAD', 'CDF', 'CHF', 'CLP', 'CNY', 'COP', 'CRC', 'CVE', 'CZK', 'DJF', 'DKK',
  'DOP', 'DZD', 'EGP', 'ETB', 'EUR', 'FJD', 'FKP', 'GBP', 'GEL', 'GIP', 'GMD',
  'GNF', 'GTQ', 'GYD', 'HKD', 'HNL', 'HTG', 'HUF', 'IDR', 'ILS', 'INR', 'ISK',
  'JMD', 'JPY', 'KES', 'KGS', 'KHR', 'KMF', 'KRW', 'KYD', 'KZT', 'LAK', 'LBP',
  'LKR', 'LRD', 'LSL', 'MAD', 'MDL', 'MGA', 'MKD', 'MMK', 'MNT', 'MOP', 'MUR',
  'MVR', 'MWK', 'MXN', 'MYR', 'MZN', 'NAD', 'NGN', 'NIO', 'NOK', 'NPR', 'NZD',
  'PAB', 'PEN', 'PGK', 'PHP', 'PKR', 'PLN', 'PYG', 'QAR', 'RON', 'RSD', 'RUB',
  'RWF', 'SAR', 'SBD', 'SCR', 'SEK', 'SGD', 'SHP', 'SLE', 'SOS', 'SRD', 'SZL',
  'THB', 'TJS', 'TOP', 'TRY', 'TTD', 'TWD', 'TZS', 'UAH', 'UGX', 'USD', 'UYU',
  'UZS', 'VND', 'VUV', 'WST', 'XAF', 'XCD', 'XCG', 'XOF', 'XPF', 'YER', 'ZAR',
  'ZMW',
]);

/** Bindings copy with effective credentials filled in — services stay env-shaped. */
export async function effectiveProviderEnv(env: Bindings, settings: Settings): Promise<Bindings> {
  const key = env.SETTINGS_MASTER_KEY;
  const [stripeKey, stripeWebhook, paypalSecret, resendKey] = await Promise.all([
    pick(key, env.STRIPE_SECRET_KEY, settings.stripe_secret_key),
    pick(key, env.STRIPE_WEBHOOK_SECRET, settings.stripe_webhook_secret),
    pick(key, env.PAYPAL_CLIENT_SECRET, settings.paypal_client_secret),
    pick(key, env.RESEND_API_KEY, settings.resend_api_key),
  ]);
  return {
    ...env,
    STRIPE_SECRET_KEY: stripeKey,
    STRIPE_WEBHOOK_SECRET: stripeWebhook,
    // Client id / webhook id are identifiers, not secrets — stored plaintext
    // and shown in full on the Settings page.
    PAYPAL_CLIENT_ID: await pick(key, env.PAYPAL_CLIENT_ID, settings.paypal_client_id),
    PAYPAL_CLIENT_SECRET: paypalSecret,
    PAYPAL_WEBHOOK_ID: await pick(key, env.PAYPAL_WEBHOOK_ID, settings.paypal_webhook_id),
    // Env var (wrangler config) wins; otherwise the Settings live/sandbox selector
    PAYPAL_API_BASE:
      (env.PAYPAL_API_BASE ?? '').trim() ||
      (settings.paypal_environment === 'sandbox' ? PAYPAL_SANDBOX_BASE : PAYPAL_LIVE_BASE),
    RESEND_API_KEY: resendKey,
  };
}

/**
 * Toggle on AND credentials present AND (when an invoice currency is given)
 * the provider can charge that currency — drives pay-page buttons and POST
 * guards, so unsupported providers are hidden instead of failing at checkout.
 */
export async function providerAvailability(
  env: Bindings,
  settings: Settings,
  currency?: string
): Promise<{ stripe: boolean; paypal: boolean }> {
  const e = await effectiveProviderEnv(env, settings);
  return {
    stripe: !!settings.stripe_enabled && !!e.STRIPE_SECRET_KEY && (!currency || STRIPE_CURRENCIES.has(currency)),
    paypal:
      !!settings.paypal_enabled &&
      !!e.PAYPAL_CLIENT_ID &&
      !!e.PAYPAL_CLIENT_SECRET &&
      (!currency || PAYPAL_CURRENCIES.has(currency)),
  };
}

export type KeySource = 'secret' | 'settings' | 'none';

/** Where a field's effective value comes from — for Settings-page provenance labels. */
export function keySource(secret: string | undefined, stored: string | undefined): KeySource {
  if (secretConfigured(secret)) return 'secret';
  const s = (stored ?? '').trim();
  if (isBoxed(s) || secretConfigured(s)) return 'settings';
  return 'none';
}

export type StoredSecretsHealth = { plaintextStored: boolean; undecryptable: boolean };

/** Encryption state of the stored (D1) secret columns — drives config warnings. */
export async function storedSecretsHealth(env: Bindings, settings: Settings): Promise<StoredSecretsHealth> {
  const health: StoredSecretsHealth = { plaintextStored: false, undecryptable: false };
  for (const col of SECRET_SETTINGS_COLUMNS) {
    const v = (settings[col] ?? '').trim();
    if (!v) continue;
    if (!isBoxed(v)) health.plaintextStored = true;
    else if ((await unbox(env.SETTINGS_MASTER_KEY, v)) === undefined) health.undecryptable = true;
  }
  return health;
}

/**
 * Lazy migration: once a master key exists, re-encrypt any plaintext stored
 * secrets in place. Idempotent (boxed values are skipped); runs on Settings
 * page loads so existing deployments converge without a manual step.
 */
export async function encryptStoredSecrets(db: D1Database, env: Bindings, settings: Settings): Promise<void> {
  const key = validMasterKey(env.SETTINGS_MASTER_KEY);
  if (!key) return;
  for (const col of SECRET_SETTINGS_COLUMNS) {
    const v = (settings[col] ?? '').trim();
    if (v && !isBoxed(v)) await setSecretSetting(db, col, await box(key, v));
  }
}
