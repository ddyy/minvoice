import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { csrfGuard } from './csrf';

function app() {
  const a = new Hono();
  a.use('/admin/*', csrfGuard);
  a.get('/admin/x', (c) => c.text('ok'));
  a.post('/admin/x', (c) => c.text('ok'));
  return a;
}

const post = (headers: Record<string, string> = {}) =>
  app().request('http://app.example/admin/x', { method: 'POST', headers });

describe('csrfGuard', () => {
  it('allows safe methods regardless of origin', async () => {
    const res = await app().request('http://app.example/admin/x', {
      method: 'GET',
      headers: { 'Sec-Fetch-Site': 'cross-site' },
    });
    expect(res.status).toBe(200);
  });

  it('allows same-origin and none via Sec-Fetch-Site', async () => {
    expect((await post({ 'Sec-Fetch-Site': 'same-origin' })).status).toBe(200);
    expect((await post({ 'Sec-Fetch-Site': 'none' })).status).toBe(200);
  });

  it('blocks cross-site and same-site via Sec-Fetch-Site', async () => {
    expect((await post({ 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403);
    expect((await post({ 'Sec-Fetch-Site': 'same-site' })).status).toBe(403);
  });

  it('falls back to an Origin host match when Sec-Fetch-Site is absent', async () => {
    expect((await post({ Origin: 'https://app.example' })).status).toBe(200);
    expect((await post({ Origin: 'https://evil.example' })).status).toBe(403);
    expect((await post({ Origin: 'not a url' })).status).toBe(403);
  });

  it('rejects when neither signal is present', async () => {
    expect((await post()).status).toBe(403);
  });
});
