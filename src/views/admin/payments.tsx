import { Layout } from '../layout';
import { formatCents } from '../../lib/money';
import { formatTimestamp } from '../../lib/dates';
import type { Client, PaymentListRow } from '../../db/queries';
import { ShortRef } from './invoice-detail';

/** Same dashboard-deep-link treatment as the invoice page's Payments card. */
function RefLink({ p }: { p: PaymentListRow }) {
  if (p.provider === 'stripe' && p.stripe_payment_intent && p.provider_ref) {
    return (
      <a
        href={`https://dashboard.stripe.com/${
          p.provider_ref.startsWith('cs_test_') ? 'test/' : ''
        }payments/${p.stripe_payment_intent}`}
        target="_blank"
        rel="noopener"
        title="Open in Stripe dashboard (refunds live there)"
      >
        <ShortRef value={p.provider_ref} />
      </a>
    );
  }
  if (p.provider === 'paypal' && p.provider_ref) {
    return (
      <a
        href={`https://www.paypal.com/activity/payment/${p.provider_ref}`}
        target="_blank"
        rel="noopener"
        title="Open in PayPal activity (refunds live there)"
      >
        <ShortRef value={p.provider_ref} />
      </a>
    );
  }
  if (p.provider_ref) return <ShortRef value={p.provider_ref} />;
  return <>—</>;
}

export function PaymentsPage({
  currentPath,
  payments,
  timezone,
  currency,
  clients,
  clientId,
}: {
  currentPath: string;
  payments: PaymentListRow[];
  timezone: string;
  currency: string;
  clients: Client[];
  clientId: number | null;
}) {
  const active = payments.filter((p) => !p.undone_at);
  // One sum per currency — amounts in different currencies are never added together
  const receivedByCurrency = new Map<string, number>();
  for (const p of active) {
    receivedByCurrency.set(p.currency, (receivedByCurrency.get(p.currency) ?? 0) + p.amount_cents);
  }
  const receivedTotals = [...receivedByCurrency.entries()]
    .sort(([a], [b]) => (a === currency ? -1 : b === currency ? 1 : a < b ? -1 : 1))
    .map(([cur, cents]) => formatCents(cents, cur))
    .join(' + ');

  return (
    <Layout title="Payments" currentPath={currentPath}>
      <div class="page-head">
        <h1 class="page-title">Payments</h1>
        <div class="actions">
          {clients.length > 1 ? (
            <form method="get" action="/admin/payments" class="client-filter">
              <select name="client" aria-label="Filter by client" onchange="this.form.submit()">
                <option value="">All clients</option>
                {clients.map((cl) => (
                  <option value={String(cl.id)} selected={cl.id === clientId}>
                    {cl.name}
                  </option>
                ))}
              </select>
            </form>
          ) : null}
          <a class="btn btn-secondary btn-sm" href="/admin/export/payments.csv">
            Export payments CSV
          </a>
        </div>
      </div>

      {payments.length === 0 ? (
        <div class="empty-state">
          <p>
            {clientId
              ? 'No payments from this client yet.'
              : "No payments recorded yet — they'll appear here as invoices get paid."}
          </p>
        </div>
      ) : (
        <div class="card">
          <p class="muted">
            {active.length} payment{active.length === 1 ? '' : 's'} ·{' '}
            {receivedTotals || formatCents(0, currency)} received
          </p>
          <table class="table table--stack">
            <thead>
              <tr>
                <th>Date</th>
                <th>Invoice</th>
                <th>Client</th>
                <th>Provider</th>
                <th>Reference</th>
                <th class="text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {payments.map((p) => (
                <tr class={p.undone_at ? 'payment-undone' : ''}>
                  <td data-label="Date">{formatTimestamp(p.created_at, timezone)}</td>
                  <td data-label="Invoice">
                    <a href={`/admin/invoices/${p.invoice_id}`}>{p.invoice_number}</a>
                  </td>
                  <td data-label="Client">
                    <a href={`/admin/clients/${p.client_id}`}>{p.client_name}</a>
                  </td>
                  <td data-label="Provider">
                    {p.provider}
                    {p.undone_at ? <span class="muted"> (undone)</span> : null}
                  </td>
                  <td data-label="Reference">
                    <RefLink p={p} />
                  </td>
                  <td class="text-right" data-label="Amount">
                    {formatCents(p.amount_cents, p.currency)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Layout>
  );
}
