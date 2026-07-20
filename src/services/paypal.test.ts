import { describe, expect, it } from 'vitest';
import { orderIdempotencyKey } from './paypal';
import type { Invoice } from '../db/queries';

const invoice = (over: Partial<Invoice> = {}): Invoice =>
  ({
    id: 7,
    total_cents: 10000,
    currency: 'USD',
    updated_at: '2026-07-18 13:50:24',
    ...over,
  }) as Invoice;

describe('orderIdempotencyKey', () => {
  it('never exceeds the 38-byte PayPal-Request-Id limit', async () => {
    const key = await orderIdempotencyKey(invoice());
    expect(key.length).toBeLessThanOrEqual(38);
    // even for large ids/totals the hashed form stays fixed-length
    const big = await orderIdempotencyKey(invoice({ id: 987654321, total_cents: 999999999999 }));
    expect(big.length).toBeLessThanOrEqual(38);
  });

  it('is deterministic and changes when the total, currency, or revision changes', async () => {
    const base = await orderIdempotencyKey(invoice());
    expect(await orderIdempotencyKey(invoice())).toBe(base);
    expect(await orderIdempotencyKey(invoice({ total_cents: 5000 }))).not.toBe(base);
    expect(await orderIdempotencyKey(invoice({ currency: 'EUR' }))).not.toBe(base);
    expect(await orderIdempotencyKey(invoice({ updated_at: '2026-07-19 09:00:00' }))).not.toBe(base);
  });

  it('is header-safe (no spaces or exotic characters)', async () => {
    expect(await orderIdempotencyKey(invoice())).toMatch(/^[A-Za-z0-9-]+$/);
  });
});
