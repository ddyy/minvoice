import type { Bindings } from '../env';
import type { Settings } from '../db/queries';
import { secretConfigured } from './config';

/**
 * Payment/email credentials can live in two places:
 * - wrangler secrets (encrypted at rest) — the hardened path, always wins
 * - Settings columns in D1 — the zero-CLI convenience path
 * This resolves the effective value per field and exposes availability
 * (toggle AND credentials) for UI gating.
 */

function pick(secret: string | undefined, stored: string | undefined): string | undefined {
  if (secretConfigured(secret)) return secret;
  const s = (stored ?? '').trim();
  return secretConfigured(s) ? s : undefined;
}

export const PAYPAL_LIVE_BASE = 'https://api-m.paypal.com';
export const PAYPAL_SANDBOX_BASE = 'https://api-m.sandbox.paypal.com';

/** Bindings copy with effective credentials filled in — services stay env-shaped. */
export function effectiveProviderEnv(env: Bindings, settings: Settings): Bindings {
  return {
    ...env,
    STRIPE_SECRET_KEY: pick(env.STRIPE_SECRET_KEY, settings.stripe_secret_key),
    STRIPE_WEBHOOK_SECRET: pick(env.STRIPE_WEBHOOK_SECRET, settings.stripe_webhook_secret),
    PAYPAL_CLIENT_ID: pick(env.PAYPAL_CLIENT_ID, settings.paypal_client_id),
    PAYPAL_CLIENT_SECRET: pick(env.PAYPAL_CLIENT_SECRET, settings.paypal_client_secret),
    PAYPAL_WEBHOOK_ID: pick(env.PAYPAL_WEBHOOK_ID, settings.paypal_webhook_id),
    // Env var (wrangler config) wins; otherwise the Settings live/sandbox selector
    PAYPAL_API_BASE:
      (env.PAYPAL_API_BASE ?? '').trim() ||
      (settings.paypal_environment === 'sandbox' ? PAYPAL_SANDBOX_BASE : PAYPAL_LIVE_BASE),
    RESEND_API_KEY: pick(env.RESEND_API_KEY, settings.resend_api_key),
  };
}

/** Toggle on AND credentials present — drives pay-page buttons and POST guards. */
export function providerAvailability(env: Bindings, settings: Settings): { stripe: boolean; paypal: boolean } {
  const e = effectiveProviderEnv(env, settings);
  return {
    stripe: !!settings.stripe_enabled && !!e.STRIPE_SECRET_KEY,
    paypal: !!settings.paypal_enabled && !!e.PAYPAL_CLIENT_ID && !!e.PAYPAL_CLIENT_SECRET,
  };
}

export type KeySource = 'secret' | 'settings' | 'none';

/** Where a field's effective value comes from — for Settings-page provenance labels. */
export function keySource(secret: string | undefined, stored: string | undefined): KeySource {
  if (secretConfigured(secret)) return 'secret';
  if (secretConfigured((stored ?? '').trim())) return 'settings';
  return 'none';
}
