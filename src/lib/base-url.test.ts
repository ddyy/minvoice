import { describe, expect, it } from 'vitest';
import { resolveBaseUrl } from './base-url';

describe('resolveBaseUrl', () => {
  it('prefers the configured value, trimming trailing slashes', () => {
    expect(resolveBaseUrl('https://invoice.example.com', 'https://x.workers.dev/pay/t')).toBe(
      'https://invoice.example.com'
    );
    expect(resolveBaseUrl('https://invoice.example.com/', 'https://x.workers.dev/')).toBe(
      'https://invoice.example.com'
    );
  });

  it('ignores a leaked localhost base on real edge requests', () => {
    expect(
      resolveBaseUrl('http://localhost:8787', 'https://minvoice.acme.workers.dev/pay/t', false)
    ).toBe('https://minvoice.acme.workers.dev');
    // still honored when actually developing locally
    expect(resolveBaseUrl('http://localhost:8787', 'http://localhost:8787/pay/t', true)).toBe(
      'http://localhost:8787'
    );
    // wrangler dev emulates the route host in request.url — the localhost
    // base must survive even though the URL looks like production
    expect(
      resolveBaseUrl('http://localhost:8787', 'https://invoice.example.com/admin/invoices/1', true)
    ).toBe('http://localhost:8787');
    expect(resolveBaseUrl('not a url', 'https://a.b/c')).toBe('https://a.b');
  });

  it('falls back to the request origin when unset or blank', () => {
    expect(resolveBaseUrl(undefined, 'https://minvoice.acme.workers.dev/pay/tok?x=1')).toBe(
      'https://minvoice.acme.workers.dev'
    );
    expect(resolveBaseUrl('', 'http://localhost:8787/admin')).toBe('http://localhost:8787');
    expect(resolveBaseUrl('   ', 'https://a.b.c/d')).toBe('https://a.b.c');
  });
});
