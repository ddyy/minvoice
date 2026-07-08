import { describe, expect, it } from 'vitest';
import { configWarnings } from './config';
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
  it('is silent when everything is set', () => {
    expect(configWarnings(fullEnv, cf)).toEqual([]);
  });

  it('flags each missing payment secret', () => {
    const env = { ...fullEnv, STRIPE_SECRET_KEY: '', PAYPAL_WEBHOOK_ID: undefined } as unknown as Bindings;
    const w = configWarnings(env, cf);
    expect(w.some((m) => m.includes('STRIPE_SECRET_KEY'))).toBe(true);
    expect(w.some((m) => m.includes('PAYPAL_WEBHOOK_ID'))).toBe(true);
    expect(w).toHaveLength(2);
  });

  it('flags missing PayPal credentials as one warning', () => {
    const env = { ...fullEnv, PAYPAL_CLIENT_ID: '' } as Bindings;
    expect(configWarnings(env, cf).filter((m) => m.includes('PayPal is enabled but'))).toHaveLength(1);
  });

  it('flags cloudflare email provider without the send_email binding', () => {
    const env = { ...fullEnv, EMAIL: undefined } as unknown as Bindings;
    expect(configWarnings(env, cf).some((m) => m.includes('send_email binding'))).toBe(true);
    expect(configWarnings(env, resend)).toEqual([]);
  });

  it('nudges toward Access when running on password auth', () => {
    const env = { ...fullEnv, ADMIN_PASSWORD: 'pw' } as Bindings;
    expect(configWarnings(env, cf).some((m) => m.includes('password-based'))).toBe(true);
    // access configured -> no nudge
    const accessEnv = {
      ...fullEnv,
      ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com',
      ACCESS_AUD: 'a'.repeat(64),
      ADMIN_PASSWORD: 'pw',
    } as Bindings;
    expect(configWarnings(accessEnv, cf)).toEqual([]);
  });

  it('flags a missing From address', () => {
    const noFrom = { ...cf, email_from: '' } as Settings;
    expect(configWarnings(fullEnv, noFrom).some((m) => m.includes('From address'))).toBe(true);
  });

  it('only requires a Resend key when Resend is selected', () => {
    const env = { ...fullEnv, RESEND_API_KEY: undefined } as Bindings;
    expect(configWarnings(env, cf)).toEqual([]);
    expect(configWarnings(env, resend).some((m) => m.includes('Resend API key'))).toBe(true);
  });

  it('email provider "none" replaces config warnings with a single emails-off notice', () => {
    const env = { ...fullEnv, RESEND_API_KEY: undefined, EMAIL: undefined } as unknown as Bindings;
    const none = { ...cf, email_provider: 'none', email_from: '' } as Settings;
    const w = configWarnings(env, none);
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('Email sending is off');
  });

  it('suppresses only the PayPal webhook-id warning in local dev', () => {
    const env = { ...fullEnv, PAYPAL_WEBHOOK_ID: '' } as Bindings;
    expect(configWarnings(env, cf).some((m) => m.includes('PAYPAL_WEBHOOK_ID'))).toBe(true);
    expect(configWarnings(env, cf, { localDev: true })).toEqual([]);
    // other warnings survive local dev
    const noStripe = { ...fullEnv, STRIPE_SECRET_KEY: '' } as Bindings;
    expect(configWarnings(noStripe, cf, { localDev: true }).some((m) => m.includes('STRIPE_SECRET_KEY'))).toBe(true);
  });

  it('both providers off yields exactly the no-payment-methods notice', () => {
    const env = { ...fullEnv, STRIPE_SECRET_KEY: '', PAYPAL_CLIENT_ID: '' } as Bindings;
    const off = { ...cf, stripe_enabled: 0, paypal_enabled: 0 } as Settings;
    const w = configWarnings(env, off);
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('No payment methods are enabled');
  });

  it('one enabled provider is enough to avoid the no-payments notice', () => {
    const on = { ...cf, paypal_enabled: 0, stripe_secret_key: 'sk_live_x' } as Settings;
    expect(configWarnings(fullEnv, on).some((m) => m.includes('No payment methods'))).toBe(false);
  });

  it('settings-stored keys satisfy the checks', () => {
    const env = { ...fullEnv, STRIPE_SECRET_KEY: '', STRIPE_WEBHOOK_SECRET: '' } as unknown as Bindings;
    const stored = { ...cf, stripe_secret_key: 'sk_live_db', stripe_webhook_secret: 'whsec_db' } as Settings;
    expect(configWarnings(env, stored)).toEqual([]);
  });
});
