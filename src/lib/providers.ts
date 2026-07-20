import type { Bindings } from '../env';
import type { Settings } from '../db/queries';
import { setSecretSetting, SECRET_SETTINGS_COLUMNS } from '../db/queries';
import { secretConfigured } from './config';
import { box, isBoxed, unbox } from './secretbox';

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

/** Toggle on AND credentials present — drives pay-page buttons and POST guards. */
export async function providerAvailability(env: Bindings, settings: Settings): Promise<{ stripe: boolean; paypal: boolean }> {
  const e = await effectiveProviderEnv(env, settings);
  return {
    stripe: !!settings.stripe_enabled && !!e.STRIPE_SECRET_KEY,
    paypal: !!settings.paypal_enabled && !!e.PAYPAL_CLIENT_ID && !!e.PAYPAL_CLIENT_SECRET,
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
  if (!env.SETTINGS_MASTER_KEY) return;
  for (const col of SECRET_SETTINGS_COLUMNS) {
    const v = (settings[col] ?? '').trim();
    if (v && !isBoxed(v)) await setSecretSetting(db, col, await box(env.SETTINGS_MASTER_KEY, v));
  }
}
