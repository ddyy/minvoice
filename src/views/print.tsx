import { raw } from 'hono/html';
import type { InvoiceItem, InvoiceWithClient, Settings } from '../db/queries';
import { formatCents, formatTaxRate } from '../lib/money';

/**
 * Print-optimized invoice document. Deliberately standalone — no app layout,
 * no global stylesheet — so it prints as clean stationery: white sheet, real
 * typography, no buttons. The toolbar exists on screen only.
 */
export function PrintInvoice({
  invoice,
  items,
  settings,
  payUrl,
}: {
  invoice: InvoiceWithClient;
  items: InvoiceItem[];
  settings: Settings;
  payUrl: string;
}) {
  const cur = invoice.currency;
  const stamp = invoice.status === 'paid' ? 'PAID' : invoice.status === 'void' ? 'VOID' : null;

  return (
    <>
      {raw('<!DOCTYPE html>')}
      <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{`Invoice ${invoice.number}`}</title>
        <style
          dangerouslySetInnerHTML={{
            __html: `
@font-face {
  font-family: 'Fraunces';
  font-style: normal;
  font-weight: 400 700;
  font-display: swap;
  src: url('/fonts/fraunces.woff2') format('woff2');
}
@font-face {
  font-family: 'Instrument Sans';
  font-style: normal;
  font-weight: 400 700;
  font-display: swap;
  src: url('/fonts/instrument-sans.woff2') format('woff2');
}
:root {
  --paper: #f6f4ee;
  --ink: #1d1a15;
  --ink-soft: #6b6459;
  --ink-faint: #756e61;
  --line: #e3ded2;
  --line-strong: #cfc8b8;
  --green: #1e5b43;
  --rust: #a8402a;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--paper);
  color: var(--ink);
  font-family: 'Instrument Sans', system-ui, sans-serif;
  font-size: 13.5px;
  line-height: 1.5;
}
.toolbar {
  max-width: 720px;
  margin: 0 auto;
  padding: 16px 24px 0;
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}
.toolbar a, .toolbar button {
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  color: var(--ink);
  background: none;
  border: 1px solid var(--line-strong);
  border-radius: 6px;
  padding: 6px 14px;
  cursor: pointer;
  text-decoration: none;
}
.toolbar button { background: var(--green); border-color: var(--green); color: #fdfdf9; }
.sheet {
  max-width: 720px;
  margin: 16px auto 48px;
  background: #fdfdf9;
  border-top: 4px solid var(--green);
  box-shadow: 0 2px 24px rgba(29, 26, 21, 0.1);
  padding: 52px 58px 44px;
  position: relative;
}
.biz { display: flex; justify-content: space-between; align-items: flex-start; gap: 24px; }
.biz-name {
  font-family: 'Fraunces', Georgia, serif;
  font-size: 26px;
  font-weight: 600;
  margin: 0;
  color: var(--green);
}
.biz-contact { text-align: right; color: var(--ink-soft); font-size: 12.5px; white-space: pre-line; }
.doc-label {
  margin: 40px 0 4px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.28em;
  text-transform: uppercase;
  color: var(--ink-faint);
}
.doc-number { font-family: 'Fraunces', Georgia, serif; font-size: 21px; margin: 0 0 22px; }
.doc-subject { color: var(--ink-soft); font-size: 14px; margin: -16px 0 22px; }
td.desc { white-space: pre-line; }
.meta {
  display: flex;
  gap: 48px;
  padding: 14px 0;
  border-top: 1px solid var(--line);
  border-bottom: 1px solid var(--line);
  margin-bottom: 28px;
}
.meta dt {
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--ink-faint);
  margin: 0 0 2px;
}
.meta dd { margin: 0; font-variant-numeric: tabular-nums; }
table { width: 100%; border-collapse: collapse; }
th {
  text-align: left;
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--ink-faint);
  padding: 0 0 8px;
  border-bottom: 1px solid var(--line-strong);
}
td { padding: 9px 0; border-bottom: 1px solid var(--line); vertical-align: top; }
tr { break-inside: avoid; }
.num { text-align: right; font-variant-numeric: tabular-nums; }
/* Qty/unit are supporting math — the amount column carries the row */
.num.dim { color: var(--ink-soft); }
.totals { margin-left: auto; width: 260px; margin-top: 18px; }
.totals-row { display: flex; justify-content: space-between; padding: 4px 0; color: var(--ink-soft); }
.totals-row span:last-child { font-variant-numeric: tabular-nums; color: var(--ink); }
.totals-final {
  display: flex;
  justify-content: space-between;
  margin-top: 6px;
  padding-top: 10px;
  border-top: 2px solid var(--ink);
  font-family: 'Fraunces', Georgia, serif;
  font-size: 17px;
  font-weight: 600;
}
.notes { margin-top: 34px; break-inside: avoid; }
.notes-label {
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--ink-faint);
}
.notes p { margin: 4px 0 0; white-space: pre-line; }
.pay-footer {
  margin-top: 40px;
  padding-top: 14px;
  border-top: 1px solid var(--line);
  font-size: 12px;
  color: var(--ink-soft);
  break-inside: avoid;
}
.pay-footer a { color: var(--green); word-break: break-all; }
.stamp {
  position: absolute;
  top: 46px;
  right: 54px;
  transform: rotate(-8deg);
  font-family: 'Fraunces', Georgia, serif;
  font-size: 20px;
  font-weight: 700;
  letter-spacing: 0.18em;
  padding: 6px 16px;
  border: 3px solid;
  border-radius: 6px;
}
.stamp-paid { color: var(--green); border-color: var(--green); }
.stamp-void { color: var(--rust); border-color: var(--rust); }
@page { size: letter; margin: 0.6in; }
@media print {
  body { background: #fff; }
  .toolbar { display: none; }
  .sheet {
    max-width: none;
    margin: 0;
    padding: 0;
    box-shadow: none;
    border-top: none;
  }
}
`,
          }}
        ></style>
      </head>
      <body>
        <div class="toolbar">
          <a href={payUrl}>View online</a>
          <button type="button" onclick="window.print()">
            Print
          </button>
        </div>
        <div class="sheet">
          {stamp ? <span class={`stamp stamp-${invoice.status}`}>{stamp}</span> : null}

          <header class="biz">
            <h1 class="biz-name">{settings.business_name}</h1>
            <div class="biz-contact">
              {settings.business_address}
              {settings.business_email ? `\n${settings.business_email}` : ''}
            </div>
          </header>

          <p class="doc-label">Invoice</p>
          <p class="doc-number">{invoice.number}</p>
          {invoice.subject ? <p class="doc-subject">{invoice.subject}</p> : null}

          <dl class="meta">
            <div>
              <dt>Billed to</dt>
              <dd>{invoice.client_name}</dd>
            </div>
            <div>
              <dt>Issued</dt>
              <dd>{invoice.issue_date}</dd>
            </div>
            {invoice.due_date ? (
              <div>
                <dt>Due</dt>
                <dd>{invoice.due_date}</dd>
              </div>
            ) : null}
            {invoice.paid_at ? (
              <div>
                <dt>Paid</dt>
                <dd>{invoice.paid_at.slice(0, 10)}</dd>
              </div>
            ) : null}
          </dl>

          <table>
            <thead>
              <tr>
                <th>Description</th>
                <th class="num">Qty</th>
                <th class="num">Unit price</th>
                <th class="num">Amount</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => (
                <tr>
                  <td class="desc">{it.description}</td>
                  <td class="num dim">{it.quantity}</td>
                  <td class="num dim">{formatCents(it.unit_price_cents, cur)}</td>
                  <td class="num">{formatCents(it.amount_cents, cur)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div class="totals">
            <div class="totals-row">
              <span>Subtotal</span>
              <span>{formatCents(invoice.subtotal_cents, cur)}</span>
            </div>
            {invoice.tax_cents > 0 ? (
              <div class="totals-row">
                <span>Tax ({formatTaxRate(invoice.tax_rate_bps)})</span>
                <span>{formatCents(invoice.tax_cents, cur)}</span>
              </div>
            ) : null}
            <div class="totals-final">
              <span>Total</span>
              <span>{formatCents(invoice.total_cents, cur)}</span>
            </div>
          </div>

          {invoice.notes ? (
            <div class="notes">
              <span class="notes-label">Notes</span>
              <p>{invoice.notes}</p>
            </div>
          ) : null}

          {invoice.status === 'sent' ? (
            <div class="pay-footer">
              Pay online: <a href={payUrl}>{payUrl}</a>
            </div>
          ) : null}
        </div>
        <script
          dangerouslySetInnerHTML={{
            __html: `
// ?auto=1 (the "Print" buttons elsewhere in the app) opens the dialog
// immediately — but only after fonts load, so the paper copy isn't Georgia.
if (new URLSearchParams(location.search).get('auto') === '1') {
  document.fonts.ready.then(function () { setTimeout(function () { window.print(); }, 50); });
}
`,
          }}
        ></script>
      </body>
      </html>
    </>
  );
}
