import { Layout } from '../layout';
import { formatCents } from '../../lib/money';
import { isOverdue, type InvoiceWithClient } from '../../db/queries';
import { Icon } from '../icons';

export function StatusBadge({
  invoice,
  today,
}: {
  invoice: Pick<InvoiceWithClient, 'status' | 'due_date'>;
  today?: string;
}) {
  if (isOverdue(invoice, today)) {
    return <span class="badge badge-overdue">overdue</span>;
  }
  return <span class={`badge badge-${invoice.status}`}>{invoice.status}</span>;
}

export const INVOICE_FILTERS = ['all', 'draft', 'open', 'overdue', 'paid', 'void'] as const;
export type InvoiceFilter = (typeof INVOICE_FILTERS)[number];

export function matchesFilter(inv: InvoiceWithClient, filter: InvoiceFilter, today?: string): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'open':
      return inv.status === 'sent'; // includes overdue
    case 'overdue':
      return isOverdue(inv, today);
    default:
      return inv.status === filter;
  }
}

const FILTER_LABELS: Record<InvoiceFilter, string> = {
  all: 'All',
  draft: 'Draft',
  open: 'Open',
  overdue: 'Overdue',
  paid: 'Paid',
  void: 'Void',
};

const EMPTY_MESSAGES: Record<InvoiceFilter, string> = {
  all: 'No invoices yet.',
  draft: 'No draft invoices.',
  open: 'No open invoices — everything is settled.',
  overdue: 'Nothing overdue. 🎉',
  paid: 'No paid invoices yet.',
  void: 'No voided invoices.',
};

export function DashboardPage({
  invoices,
  filter,
  clientId,
  today,
  warnings,
  deleted,
  currentPath,
}: {
  invoices: InvoiceWithClient[];
  filter: InvoiceFilter;
  /** When set, only this client's invoices are shown (tab counts follow). */
  clientId?: number;
  today: string;
  warnings?: string[];
  /** Invoice number just deleted — success banner. */
  deleted?: string;
  currentPath: string;
}) {
  // Client dropdown options come from the invoices themselves — clients
  // without invoices would be dead filters anyway.
  const clientOptions = [...new Map(invoices.map((i) => [i.client_id, i.client_name])).entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const scoped = clientId ? invoices.filter((inv) => inv.client_id === clientId) : invoices;

  const visible = scoped.filter((inv) => matchesFilter(inv, filter, today));
  const counts = Object.fromEntries(
    INVOICE_FILTERS.map((f) => [f, scoped.filter((inv) => matchesFilter(inv, f, today)).length])
  ) as Record<InvoiceFilter, number>;

  const tabHref = (f: InvoiceFilter) => {
    const params = new URLSearchParams();
    if (f !== 'all') params.set('status', f);
    if (clientId) params.set('client', String(clientId));
    const qs = params.toString();
    return qs ? `/admin?${qs}` : '/admin';
  };

  return (
    <Layout title="Invoices" currentPath={currentPath}>
      <div class="page-head">
        <h1 class="page-title">Invoices</h1>
        <div class="actions">
          <a class="btn btn-primary" href="/admin/invoices/new">
            <Icon name="plus" />
            New invoice
          </a>
        </div>
      </div>

      {deleted ? <div class="banner banner-success">Invoice {deleted} deleted.</div> : null}

      {warnings?.length ? (
        <div class="banner banner-warning">
          <strong>Configuration warnings</strong>
          <ul class="warning-list">
            {warnings.map((w) => (
              <li>{w}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <div class="filter-bar">
        <nav class="filter-tabs">
          {INVOICE_FILTERS.map((f) => {
            // Hide noise: skip empty overdue/void tabs unless active
            if (counts[f] === 0 && f !== 'all' && f !== filter) return null;
            return (
              <a href={tabHref(f)} class={filter === f ? 'active' : ''}>
                {FILTER_LABELS[f]}
                <span class="filter-count">{counts[f]}</span>
              </a>
            );
          })}
        </nav>
        {clientOptions.length > 1 ? (
          <form method="get" action="/admin" class="client-filter">
            {filter !== 'all' ? <input type="hidden" name="status" value={filter} /> : null}
            <select name="client" aria-label="Filter by client" onchange="this.form.submit()">
              <option value="">All clients</option>
              {clientOptions.map((cl) => (
                <option value={String(cl.id)} selected={cl.id === clientId}>
                  {cl.name}
                </option>
              ))}
            </select>
          </form>
        ) : null}
      </div>

      {visible.length === 0 ? (
        <div class="empty-state">
          <p>{clientId ? 'No matching invoices for this client.' : EMPTY_MESSAGES[filter]}</p>
        </div>
      ) : (
        <table class="table table--stack">
          <thead>
            <tr>
              <th>Number</th>
              <th>Client</th>
              <th>Issue date</th>
              <th>Due date</th>
              <th class="text-right">Total</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((inv) => (
              <tr data-href={`/admin/invoices/${inv.id}`}>
                <td data-label="Number">
                  <a href={`/admin/invoices/${inv.id}`}>{inv.number}</a>
                  {inv.subject ? <span class="row-subject muted">{inv.subject}</span> : null}
                </td>
                <td data-label="Client">{inv.client_name}</td>
                <td data-label="Issued">{inv.issue_date}</td>
                <td data-label="Due">{inv.due_date ?? <span class="muted">—</span>}</td>
                <td class="text-right" data-label="Total">
                  {formatCents(inv.total_cents, inv.currency)}
                </td>
                <td data-label="Status">
                  <StatusBadge invoice={inv} today={today} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <script
        dangerouslySetInnerHTML={{
          __html: `
(function () {
  document.querySelectorAll('tr[data-href]').forEach(function (row) {
    row.addEventListener('click', function (e) {
      // Let real links, buttons, and text selection behave normally
      if (e.target.closest('a, button, input, form')) return;
      if (window.getSelection().toString()) return;
      var href = row.getAttribute('data-href');
      if (e.metaKey || e.ctrlKey) window.open(href, '_blank');
      else location.href = href;
    });
  });
})();
`,
        }}
      ></script>
    </Layout>
  );
}
