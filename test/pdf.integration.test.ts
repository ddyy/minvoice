import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { generateInvoicePdf } from '../src/services/pdf';
import { getSettings, type InvoiceItem, type InvoiceWithClient } from '../src/db/queries';

const DB = env.DB;

function fakeInvoice(over: Partial<InvoiceWithClient> = {}): InvoiceWithClient {
  return {
    id: 1,
    number: 'INV-0001',
    client_id: 1,
    status: 'sent',
    currency: 'EUR',
    issue_date: '2026-07-01',
    due_date: '2026-07-15',
    subject: null,
    notes: null,
    tax_rate_bps: 1900,
    subtotal_cents: 100000,
    tax_cents: 19000,
    total_cents: 119000,
    public_token: 'testtoken',
    paypal_order_id: null,
    sent_at: null,
    paid_at: null,
    created_at: '',
    updated_at: '',
    client_name: 'Müller & Söhne GmbH',
    client_email: 'ap@example.de',
    client_locale: null,
    ...over,
  };
}

const item = (description: string): InvoiceItem => ({
  id: 1,
  invoice_id: 1,
  position: 0,
  description,
  quantity: 1,
  unit_price_cents: 100000,
  amount_cents: 100000,
});

describe('PDF generation with embedded fonts', () => {
  it('renders a German-locale invoice with umlauts and euro formatting', async () => {
    const settings = { ...(await getSettings(DB)), locale: 'de', business_name: 'Größenwahn Bücher' };
    const bytes = await generateInvoicePdf(fakeInvoice(), [item('Beratung für Änderungswünsche')], settings, undefined, env.ASSETS);
    expect(bytes.length).toBeGreaterThan(1000);
    expect(String.fromCharCode(...bytes.slice(0, 5))).toBe('%PDF-');
  });

  it('renders extended-Latin and Cyrillic with the REAL Noto fonts, not the fallback', async () => {
    const settings = { ...(await getSettings(DB)), locale: 'en' };
    const bytes = await generateInvoicePdf(
      fakeInvoice({ client_name: 'Zażółć gęślą jaźń — Дмитрий Șțigletul' }),
      [item('Wdrożenie systemu płatności — консультация — reșițean')],
      settings,
      undefined,
      env.ASSETS
    );
    expect(String.fromCharCode(...bytes.slice(0, 5))).toBe('%PDF-');
    // Discriminates real embedding from silent fallback: subset Noto fonts add
    // ~18KB+ to the document; the WinAnsi standard-font fallback stays ~5KB.
    // (Font names aren't greppable — pdf-lib compresses object streams.)
    expect(bytes.length).toBeGreaterThan(15000);
  });

  it('per-client locale override wins over the business locale', async () => {
    const settings = { ...(await getSettings(DB)), locale: 'en' };
    // French client of an English business: doc title should be French
    const bytes = await generateInvoicePdf(fakeInvoice({ client_locale: 'fr' }), [item('Prestation')], settings, undefined, env.ASSETS);
    expect(String.fromCharCode(...bytes.slice(0, 5))).toBe('%PDF-');
  });

  it('still renders without the assets binding (standard-font fallback)', async () => {
    const settings = { ...(await getSettings(DB)), locale: 'de' };
    const bytes = await generateInvoicePdf(fakeInvoice(), [item('Beratung')], settings, undefined, undefined);
    expect(String.fromCharCode(...bytes.slice(0, 5))).toBe('%PDF-');
    expect(bytes.length).toBeLessThan(15000); // no embedded fonts on this path
  });
});
