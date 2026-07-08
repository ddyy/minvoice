import type { Bindings } from '../env';
import type { Settings } from '../db/queries';
import { authMode } from './admin-auth';
import { effectiveProviderEnv } from './providers';

// Example/template values that have historically leaked into real secrets
// (one-click deploys prompt from .dev.vars.example) — never treat as configured.
const PLACEHOLDER_VALUES = new Set([
  'sk_test_xxx',
  'whsec_xxx',
  'sandbox_client_id',
  'sandbox_client_secret',
  'sandbox_webhook_id',
  'change-me',
]);

/** A secret counts as configured only when set AND not a known placeholder. */
export function secretConfigured(v: string | undefined): boolean {
  const t = (v ?? '').trim();
  return t !== '' && !PLACEHOLDER_VALUES.has(t);
}

/**
 * Human-readable warnings for missing secrets — shown on the admin dashboard
 * so misconfiguration surfaces before a client hits it.
 */
export function configWarnings(
  env: Bindings,
  settings: Settings,
  opts: { localDev?: boolean } = {}
): string[] {
  const warnings: string[] = [];
  const e = effectiveProviderEnv(env, settings);

  if (settings.stripe_enabled) {
    if (!e.STRIPE_SECRET_KEY) {
      warnings.push(
        'Card payments are enabled but no STRIPE_SECRET_KEY is configured (Settings → Payments, or wrangler secret) — the card button is hidden.'
      );
    } else if (!e.STRIPE_WEBHOOK_SECRET) {
      warnings.push('STRIPE_WEBHOOK_SECRET is not configured — Stripe payments will never mark invoices paid.');
    }
  }
  if (settings.paypal_enabled) {
    if (!e.PAYPAL_CLIENT_ID || !e.PAYPAL_CLIENT_SECRET) {
      warnings.push(
        'PayPal is enabled but its credentials are not configured (Settings → Payments, or wrangler secret) — the PayPal button is hidden.'
      );
    } else if (!e.PAYPAL_WEBHOOK_ID && !opts.localDev) {
      // Suppressed in local dev: PayPal can't deliver webhooks to localhost
      // anyway — capture-on-return is the local path.
      warnings.push(
        'PAYPAL_WEBHOOK_ID is not configured — PayPal webhooks cannot be verified (capture-on-return still records payments).'
      );
    }
  }
  if (!settings.stripe_enabled && !settings.paypal_enabled) {
    warnings.push(
      'No payment methods are enabled (Settings → Payments) — clients can view invoices but not pay online.'
    );
  }
  if (settings.email_provider === 'none') {
    warnings.push(
      'Email sending is off (Settings → Email) — no invoice emails, receipts, or error alerts will be sent.'
    );
  }
  if (settings.email_provider !== 'none') {
    if (settings.email_provider === 'resend' && !e.RESEND_API_KEY) {
      warnings.push('Email provider is Resend but no Resend API key is configured — all emails will fail.');
    }
    if (settings.email_provider === 'cloudflare' && !env.EMAIL) {
      warnings.push(
        'Email provider is Cloudflare but the send_email binding is not configured — switch to Resend in Settings or add the binding.'
      );
    }
    if (!settings.email_from.trim()) {
      warnings.push('No email From address set (Settings) — invoice and receipt emails will fail.');
    }
  }
  if (authMode(env) === 'password') {
    warnings.push(
      'Admin login is password-based — configure Cloudflare Access for stronger auth (it takes over automatically).'
    );
  }
  return warnings;
}
