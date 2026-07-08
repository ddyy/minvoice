import { describe, expect, it } from 'vitest';
import { authMode, devBypassActive, signSession, timingSafeEqual, verifySession } from './admin-auth';

const REAL_AUD = 'a'.repeat(64);

describe('authMode', () => {
  it('picks access when real-looking Access values are set', () => {
    expect(authMode({ ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com', ACCESS_AUD: REAL_AUD })).toBe('access');
  });

  it('access wins even when a password is also set', () => {
    expect(
      authMode({ ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com', ACCESS_AUD: REAL_AUD, ADMIN_PASSWORD: 'pw' })
    ).toBe('access');
  });

  it('placeholder Access values do not count as configured', () => {
    expect(
      authMode({
        ACCESS_TEAM_DOMAIN: 'yourteam.cloudflareaccess.com',
        ACCESS_AUD: 'YOUR_ACCESS_APPLICATION_AUD',
        ADMIN_PASSWORD: 'pw',
      })
    ).toBe('password');
  });

  it('falls back to password, then unconfigured', () => {
    expect(authMode({ ADMIN_PASSWORD: 'pw' })).toBe('password');
    expect(authMode({})).toBe('unconfigured');
    expect(authMode({ ADMIN_PASSWORD: '' })).toBe('unconfigured');
  });
});

describe('devBypassActive', () => {
  const req = (url: string, headers: Record<string, string> = {}) => ({ url, headers: new Headers(headers) });
  const edge = { 'cf-ray': '8a1b2c3d4e5f-LAX' };

  it('active on localhost, and on emulated route hosts without cf-ray (wrangler dev)', () => {
    const env = { DEV_BYPASS_ACCESS: 'true' };
    expect(devBypassActive(env, req('http://localhost:8787/admin'))).toBe(true);
    expect(devBypassActive(env, req('http://127.0.0.1:8787/admin'))).toBe(true);
    // wrangler dev emulates the configured route host but adds no cf-ray
    expect(devBypassActive(env, req('http://invoice.example.com/admin'))).toBe(true);
  });

  it('never active for requests that traversed the Cloudflare edge', () => {
    const env = { DEV_BYPASS_ACCESS: 'true' };
    expect(devBypassActive(env, req('https://minvoice.acme.workers.dev/admin', edge))).toBe(false);
    expect(devBypassActive(env, req('https://invoice.example.com/admin', edge))).toBe(false);
  });

  it('inactive without the flag', () => {
    expect(devBypassActive({}, req('http://localhost:8787/admin'))).toBe(false);
    expect(devBypassActive({ DEV_BYPASS_ACCESS: 'false' }, req('http://localhost:8787/admin'))).toBe(false);
  });
});

describe('password sessions', () => {
  it('round-trips a valid session', async () => {
    const token = await signSession('hunter2', Date.now() + 10_000);
    expect(await verifySession('hunter2', token)).toBe(true);
  });

  it('rejects expired tokens', async () => {
    const token = await signSession('hunter2', Date.now() - 1);
    expect(await verifySession('hunter2', token)).toBe(false);
  });

  it('rejects tampered expiry', async () => {
    const token = await signSession('hunter2', Date.now() + 10_000);
    const [, mac] = token.split('.');
    expect(await verifySession('hunter2', `${Date.now() + 9_999_999}.${mac}`)).toBe(false);
  });

  it('rejects tokens signed with a different password', async () => {
    const token = await signSession('old-password', Date.now() + 10_000);
    expect(await verifySession('new-password', token)).toBe(false);
  });

  it('rejects garbage', async () => {
    expect(await verifySession('pw', undefined)).toBe(false);
    expect(await verifySession('pw', '')).toBe(false);
    expect(await verifySession('pw', 'no-dot')).toBe(false);
    expect(await verifySession('pw', '.justmac')).toBe(false);
  });
});

describe('timingSafeEqual', () => {
  it('matches equal strings and rejects different ones', async () => {
    expect(await timingSafeEqual('abc', 'abc')).toBe(true);
    expect(await timingSafeEqual('abc', 'abd')).toBe(false);
    expect(await timingSafeEqual('abc', 'abcd')).toBe(false);
  });
});
