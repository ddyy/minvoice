import { describe, expect, it } from 'vitest';
import { computeTotals, formatCents, formatTaxRate, isSupportedCurrency, itemAmountCents, parseAmountToCents } from './money';

describe('parseAmountToCents', () => {
  it('parses plain amounts', () => {
    expect(parseAmountToCents('150.00')).toBe(15000);
    expect(parseAmountToCents('0.01')).toBe(1);
    expect(parseAmountToCents('25.5')).toBe(2550);
    expect(parseAmountToCents('100')).toBe(10000);
  });

  it('tolerates currency formatting', () => {
    expect(parseAmountToCents('$1,234.50')).toBe(123450);
    expect(parseAmountToCents(' 99.99 ')).toBe(9999);
  });

  it('rejects garbage', () => {
    expect(parseAmountToCents('')).toBeNull();
    expect(parseAmountToCents('.')).toBeNull();
    expect(parseAmountToCents('abc')).toBeNull();
    expect(parseAmountToCents('12.3.4')).toBeNull();
  });
});

describe('itemAmountCents', () => {
  it('rounds fractional quantities per item', () => {
    // 2.5 hours × $150.00 = $375.00
    expect(itemAmountCents({ quantity: 2.5, unit_price_cents: 15000 })).toBe(37500);
    // 0.333 × $100.00 = $33.30
    expect(itemAmountCents({ quantity: 0.333, unit_price_cents: 10000 })).toBe(3330);
    // rounding case: 1.5 × $0.01 = 1.5 cents -> 2
    expect(itemAmountCents({ quantity: 1.5, unit_price_cents: 1 })).toBe(2);
  });
});

describe('computeTotals', () => {
  it('sums items and applies basis-point tax with single rounding', () => {
    const items = [
      { quantity: 10, unit_price_cents: 15000 }, // $1,500.00
      { quantity: 1, unit_price_cents: 2550 }, // $25.50
    ];
    const t = computeTotals(items, 0);
    expect(t).toEqual({ subtotal_cents: 152550, tax_cents: 0, total_cents: 152550 });
  });

  it('computes 8.25% tax on the subtotal', () => {
    const t = computeTotals([{ quantity: 1, unit_price_cents: 10000 }], 825);
    expect(t.tax_cents).toBe(825);
    expect(t.total_cents).toBe(10825);
  });

  it('rounds tax to the nearest cent', () => {
    // 1 cent at 8.25% = 0.0825 cents -> 0
    expect(computeTotals([{ quantity: 1, unit_price_cents: 1 }], 825).tax_cents).toBe(0);
    // $1.99 at 8.25% = 16.4175 cents -> 16
    expect(computeTotals([{ quantity: 1, unit_price_cents: 199 }], 825).tax_cents).toBe(16);
  });

  it('handles empty item lists', () => {
    expect(computeTotals([], 825)).toEqual({ subtotal_cents: 0, tax_cents: 0, total_cents: 0 });
  });
});

describe('formatting', () => {
  it('formats cents as currency', () => {
    expect(formatCents(152550, 'USD')).toBe('$1,525.50');
    expect(formatCents(0, 'USD')).toBe('$0.00');
  });

  it('formats tax rates without trailing zeros', () => {
    expect(formatTaxRate(825)).toBe('8.25%');
    expect(formatTaxRate(1000)).toBe('10%');
    expect(formatTaxRate(0)).toBe('0%');
  });
});

describe('isSupportedCurrency', () => {
  it('accepts common two-decimal currencies', () => {
    for (const c of ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'CHF']) expect(isSupportedCurrency(c)).toBe(true);
  });
  it('rejects zero-decimal currencies and malformed codes', () => {
    // Note: unassigned-but-well-formed codes (e.g. XQQ) pass — Intl can't
    // distinguish them; the payment provider rejects those at checkout.
    for (const c of ['JPY', 'KRW', 'VND', 'usd', 'DOLLARS', '']) {
      expect(isSupportedCurrency(c)).toBe(false);
    }
  });
});
