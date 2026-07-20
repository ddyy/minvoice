import { describe, expect, it } from 'vitest';
import { effectiveProviderEnv, keySource, providerAvailability } from './providers';
import { box } from './secretbox';
import type { Bindings } from '../env';
import type { Settings } from '../db/queries';

const settings = (over: Partial<Settings> = {}): Settings =>
  ({
    stripe_enabled: 1,
    paypal_enabled: 1,
    stripe_secret_key: '',
    stripe_webhook_secret: '',
    paypal_client_id: '',
    paypal_client_secret: '',
    paypal_webhook_id: '',
    paypal_environment: 'live',
    resend_api_key: '',
    ...over,
  }) as Settings;

const env = (over: Partial<Bindings> = {}): Bindings => ({ ...over }) as Bindings;

describe('effectiveProviderEnv', () => {
  it('env secret wins over a stored key', async () => {
    const e = await effectiveProviderEnv(
      env({ STRIPE_SECRET_KEY: 'sk_live_env' }),
      settings({ stripe_secret_key: 'sk_live_stored' })
    );
    expect(e.STRIPE_SECRET_KEY).toBe('sk_live_env');
  });

  it('falls back to the stored key when no env secret', async () => {
    const e = await effectiveProviderEnv(env(), settings({ stripe_secret_key: 'sk_live_stored' }));
    expect(e.STRIPE_SECRET_KEY).toBe('sk_live_stored');
  });

  it('placeholders never count, from either source', async () => {
    const e = await effectiveProviderEnv(
      env({ STRIPE_SECRET_KEY: 'sk_test_xxx' }),
      settings({ stripe_secret_key: '  ' })
    );
    expect(e.STRIPE_SECRET_KEY).toBeUndefined();
  });

  it('decrypts a boxed stored key with the master key', async () => {
    const boxed = await box('unit-test-master-key-0123456789abcdef', 'sk_live_boxed');
    const e = await effectiveProviderEnv(
      env({ SETTINGS_MASTER_KEY: 'unit-test-master-key-0123456789abcdef' }),
      settings({ stripe_secret_key: boxed })
    );
    expect(e.STRIPE_SECRET_KEY).toBe('sk_live_boxed');
  });

  it('a boxed key is unconfigured when the master key is absent or wrong', async () => {
    const boxed = await box('unit-test-master-key-0123456789abcdef', 'sk_live_boxed');
    const stored = settings({ stripe_secret_key: boxed });
    expect((await effectiveProviderEnv(env(), stored)).STRIPE_SECRET_KEY).toBeUndefined();
    expect(
      (await effectiveProviderEnv(env({ SETTINGS_MASTER_KEY: 'a-different-master-key-fedcba9876543210' }), stored)).STRIPE_SECRET_KEY
    ).toBeUndefined();
  });

  it('a boxed placeholder still never counts', async () => {
    const boxed = await box('unit-test-master-key-0123456789abcdef', 'sk_test_xxx');
    const e = await effectiveProviderEnv(
      env({ SETTINGS_MASTER_KEY: 'unit-test-master-key-0123456789abcdef' }),
      settings({ stripe_secret_key: boxed })
    );
    expect(e.STRIPE_SECRET_KEY).toBeUndefined();
  });
});

describe('providerAvailability', () => {
  it('requires the toggle AND credentials', async () => {
    const withKey = settings({ stripe_secret_key: 'sk_live_x' });
    expect((await providerAvailability(env(), withKey)).stripe).toBe(true);
    expect((await providerAvailability(env(), settings({ ...withKey, stripe_enabled: 0 }))).stripe).toBe(false);
    expect((await providerAvailability(env(), settings())).stripe).toBe(false);
  });

  it('paypal needs both id and secret', async () => {
    expect((await providerAvailability(env(), settings({ paypal_client_id: 'cid' }))).paypal).toBe(false);
    expect(
      (await providerAvailability(env(), settings({ paypal_client_id: 'cid', paypal_client_secret: 'sec' }))).paypal
    ).toBe(true);
  });

  it('toggle can silence an env-configured provider', async () => {
    const e = env({ STRIPE_SECRET_KEY: 'sk_live_env' });
    expect((await providerAvailability(e, settings())).stripe).toBe(true);
    expect((await providerAvailability(e, settings({ stripe_enabled: 0 }))).stripe).toBe(false);
  });

  it('gates each provider by its supported currency set', async () => {
    const e = env({ STRIPE_SECRET_KEY: 'sk_live_x' });
    const s = settings({ paypal_client_id: 'cid', paypal_client_secret: 'sec' });
    expect(await providerAvailability(e, s, 'EUR')).toEqual({ stripe: true, paypal: true });
    // AED: fine for Stripe, not a PayPal payment currency
    expect(await providerAvailability(e, s, 'AED')).toEqual({ stripe: true, paypal: false });
    // VES: in Intl but not a Stripe presentment currency (nor PayPal's list)
    expect(await providerAvailability(e, s, 'VES')).toEqual({ stripe: false, paypal: false });
    // no currency given (e.g. settings-level checks) -> credentials alone decide
    expect(await providerAvailability(e, s)).toEqual({ stripe: true, paypal: true });
  });

  it('an undecryptable boxed key makes the provider unavailable', async () => {
    const boxed = await box('unit-test-master-key-0123456789abcdef', 'sk_live_x');
    expect((await providerAvailability(env(), settings({ stripe_secret_key: boxed }))).stripe).toBe(false);
  });
});

describe('paypal environment', () => {
  it('env var wins; otherwise the settings selector picks the base', async () => {
    expect(
      (await effectiveProviderEnv(env({ PAYPAL_API_BASE: 'https://api-m.sandbox.paypal.com' }), settings()))
        .PAYPAL_API_BASE
    ).toBe('https://api-m.sandbox.paypal.com');
    expect((await effectiveProviderEnv(env(), settings({ paypal_environment: 'sandbox' }))).PAYPAL_API_BASE).toBe(
      'https://api-m.sandbox.paypal.com'
    );
    expect((await effectiveProviderEnv(env(), settings())).PAYPAL_API_BASE).toBe('https://api-m.paypal.com');
  });
});

describe('keySource', () => {
  it('labels provenance', async () => {
    expect(keySource('sk_live_env', 'stored')).toBe('secret');
    expect(keySource(undefined, 'stored')).toBe('settings');
    expect(keySource(undefined, '')).toBe('none');
    expect(keySource('sk_test_xxx', '')).toBe('none');
    // boxed stored values still count as settings-provided
    expect(keySource(undefined, await box('unit-test-master-key-0123456789abcdef', 'sk_live_x'))).toBe('settings');
  });
});
