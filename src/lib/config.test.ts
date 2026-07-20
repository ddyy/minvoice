import { describe, expect, it } from 'vitest';
import { configWarnings } from './config';
import { box } from './secretbox';
import type { Bindings } from '../env';
import type { Settings } from '../db/queries';

const fullEnv = {
  EMAIL: {},
  STRIPE_SECRET_KEY: 'sk',
  STRIPE_WEBHOOK_SECRET: 'whsec',
  PAYPAL_CLIENT_ID: 'cid',
  PAYPAL_CLIENT_SECRET: 'csec',
  PAYPAL_WEBHOOK_ID: 'wh',
  RESEND_API_KEY: 're',
} as Bindings;

const base = {
  email_from: 'invoices@example.com',
  stripe_enabled: 1,
  paypal_enabled: 1,
  stripe_secret_key: '',
  stripe_webhook_secret: '',
  paypal_client_id: '',
  paypal_client_secret: '',
  paypal_webhook_id: '',
  resend_api_key: '',
};
const cf = { ...base, email_provider: 'cloudflare' } as Settings;
const resend = { ...base, email_provider: 'resend' } as Settings;

describe('configWarnings', () => {
  it('is silent when everything is set', async () => {
    expect(await configWarnings(fullEnv, cf)).toEqual([]);
  });

  it('flags each missing payment secret', async () => {
    const env = { ...fullEnv, STRIPE_SECRET_KEY: '', PAYPAL_WEBHOOK_ID: undefined } as unknown as Bindings;
    const w = await configWarnings(env, cf);
    expect(w.some((m) => m.text.includes('STRIPE_SECRET_KEY'))).toBe(true);
    expect(w.some((m) => m.text.includes('PAYPAL_WEBHOOK_ID'))).toBe(true);
    expect(w).toHaveLength(2);
  });

  it('flags missing PayPal credentials as one warning', async () => {
    const env = { ...fullEnv, PAYPAL_CLIENT_ID: '' } as Bindings;
    expect((await configWarnings(env, cf)).filter((m) => m.text.includes('PayPal is enabled but'))).toHaveLength(1);
  });

  it('flags cloudflare email provider without the send_email binding', async () => {
    const env = { ...fullEnv, EMAIL: undefined } as unknown as Bindings;
    expect((await configWarnings(env, cf)).some((m) => m.text.includes('send_email binding'))).toBe(true);
    expect(await configWarnings(env, resend)).toEqual([]);
  });

  it('nudges toward Access when running on password auth', async () => {
    const env = { ...fullEnv, ADMIN_PASSWORD: 'pw' } as Bindings;
    expect((await configWarnings(env, cf)).some((m) => m.text.includes('password-based'))).toBe(true);
    // access configured -> no nudge
    const accessEnv = {
      ...fullEnv,
      ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com',
      ACCESS_AUD: 'a'.repeat(64),
      ADMIN_PASSWORD: 'pw',
    } as Bindings;
    expect(await configWarnings(accessEnv, cf)).toEqual([]);
  });

  it('flags a missing From address', async () => {
    const noFrom = { ...cf, email_from: '' } as Settings;
    expect((await configWarnings(fullEnv, noFrom)).some((m) => m.text.includes('From address'))).toBe(true);
  });

  it('only requires a Resend key when Resend is selected', async () => {
    const env = { ...fullEnv, RESEND_API_KEY: undefined } as Bindings;
    expect(await configWarnings(env, cf)).toEqual([]);
    expect((await configWarnings(env, resend)).some((m) => m.text.includes('Resend API key'))).toBe(true);
  });

  it('email provider "none" replaces config warnings with a single emails-off notice', async () => {
    const env = { ...fullEnv, RESEND_API_KEY: undefined, EMAIL: undefined } as unknown as Bindings;
    const none = { ...cf, email_provider: 'none', email_from: '' } as Settings;
    const w = await configWarnings(env, none);
    expect(w).toHaveLength(1);
    expect(w[0].text).toContain('Email sending is off');
  });

  it('suppresses only the PayPal webhook-id warning in local dev', async () => {
    const env = { ...fullEnv, PAYPAL_WEBHOOK_ID: '' } as Bindings;
    expect((await configWarnings(env, cf)).some((m) => m.text.includes('PAYPAL_WEBHOOK_ID'))).toBe(true);
    expect(await configWarnings(env, cf, { localDev: true })).toEqual([]);
    // other warnings survive local dev
    const noStripe = { ...fullEnv, STRIPE_SECRET_KEY: '' } as Bindings;
    expect((await configWarnings(noStripe, cf, { localDev: true })).some((m) => m.text.includes('STRIPE_SECRET_KEY'))).toBe(true);
  });

  it('both providers off yields exactly the no-payment-methods notice', async () => {
    const env = { ...fullEnv, STRIPE_SECRET_KEY: '', PAYPAL_CLIENT_ID: '' } as Bindings;
    const off = { ...cf, stripe_enabled: 0, paypal_enabled: 0 } as Settings;
    const w = await configWarnings(env, off);
    expect(w).toHaveLength(1);
    expect(w[0].text).toContain('No payment methods are enabled');
  });

  it('one enabled provider is enough to avoid the no-payments notice', async () => {
    const on = { ...cf, paypal_enabled: 0, stripe_secret_key: 'sk_live_x' } as Settings;
    expect((await configWarnings(fullEnv, on)).some((m) => m.text.includes('No payment methods'))).toBe(false);
  });

  it('settings-stored keys satisfy the checks (with an unencrypted advisory sans master key)', async () => {
    const env = { ...fullEnv, STRIPE_SECRET_KEY: '', STRIPE_WEBHOOK_SECRET: '' } as unknown as Bindings;
    const stored = { ...cf, stripe_secret_key: 'sk_live_db', stripe_webhook_secret: 'whsec_db' } as Settings;
    const w = await configWarnings(env, stored);
    expect(w).toHaveLength(1);
    expect(w[0].category).toBe('auth');
    expect(w[0].text).toContain('stored unencrypted');
  });

  it('boxed stored keys with the master key are silent', async () => {
    const env = { ...fullEnv, STRIPE_SECRET_KEY: '', STRIPE_WEBHOOK_SECRET: '', SETTINGS_MASTER_KEY: 'mk' } as unknown as Bindings;
    const stored = {
      ...cf,
      stripe_secret_key: await box('mk', 'sk_live_db'),
      stripe_webhook_secret: await box('mk', 'whsec_db'),
    } as Settings;
    expect(await configWarnings(env, stored)).toEqual([]);
  });

  it('flags undecryptable stored keys loudly', async () => {
    const env = { ...fullEnv, STRIPE_SECRET_KEY: '', STRIPE_WEBHOOK_SECRET: '', SETTINGS_MASTER_KEY: 'rotated' } as unknown as Bindings;
    const stored = {
      ...cf,
      stripe_secret_key: await box('mk', 'sk_live_db'),
      stripe_webhook_secret: await box('mk', 'whsec_db'),
    } as Settings;
    const w = await configWarnings(env, stored);
    expect(w.some((m) => m.category === 'payments' && m.text.includes('cannot be decrypted'))).toBe(true);
  });
});
