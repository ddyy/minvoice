/**
 * Currencies without subunits (Stripe's zero-decimal list). The whole app
 * stores hundredths and providers expect whole units for these — supporting
 * them needs real work, so they're rejected at the settings/wizard boundary.
 */
const ZERO_DECIMAL = new Set([
  'BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA', 'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF',
]);

export function isSupportedCurrency(code: string): boolean {
  if (!/^[A-Z]{3}$/.test(code) || ZERO_DECIMAL.has(code)) return false;
  try {
    new Intl.NumberFormat('en-US', { style: 'currency', currency: code });
    return true;
  } catch {
    return false;
  }
}

export function formatCents(cents: number, currency: string): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100);
}

/** Parse a user-entered amount like "1,234.50" into integer cents. Returns null on garbage. */
export function parseAmountToCents(input: string): number | null {
  const cleaned = input.replace(/[$,\s]/g, '');
  if (!/^-?\d*\.?\d{0,10}$/.test(cleaned) || cleaned === '' || cleaned === '.') return null;
  const cents = Math.round(parseFloat(cleaned) * 100);
  return Number.isFinite(cents) ? cents : null;
}

export type ItemInput = { quantity: number; unit_price_cents: number };

export function itemAmountCents(item: ItemInput): number {
  return Math.round(item.quantity * item.unit_price_cents);
}

export function computeTotals(items: ItemInput[], taxRateBps: number) {
  const subtotal_cents = items.reduce((sum, it) => sum + itemAmountCents(it), 0);
  const tax_cents = Math.round((subtotal_cents * taxRateBps) / 10_000);
  return { subtotal_cents, tax_cents, total_cents: subtotal_cents + tax_cents };
}

/** basis points -> display string, e.g. 825 -> "8.25%" */
export function formatTaxRate(bps: number): string {
  return `${(bps / 100).toFixed(2).replace(/\.?0+$/, '')}%`;
}
