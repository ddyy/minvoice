import { Layout } from '../layout';
import { formatCents } from '../../lib/money';
import type { Client, MonthlyReportRow, ReportSummary } from '../../db/queries';

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function monthLabel(ym: string): string {
  const m = Number(ym.slice(5, 7));
  return MONTH_NAMES[m - 1] ?? ym;
}

type YearGroup = {
  year: string;
  rows: MonthlyReportRow[];
  totals: Omit<MonthlyReportRow, 'ym'>;
};

function groupByYear(rows: MonthlyReportRow[]): YearGroup[] {
  const groups: YearGroup[] = [];
  for (const r of rows) {
    const year = r.ym.slice(0, 4);
    let g = groups[groups.length - 1];
    if (!g || g.year !== year) {
      g = { year, rows: [], totals: { invoiced_count: 0, invoiced_cents: 0, received_count: 0, received_cents: 0 } };
      groups.push(g);
    }
    g.rows.push(r);
    g.totals.invoiced_count += r.invoiced_count;
    g.totals.invoiced_cents += r.invoiced_cents;
    g.totals.received_count += r.received_count;
    g.totals.received_cents += r.received_cents;
  }
  return groups;
}

export function ReportsPage({
  currentPath,
  summary,
  months,
  currency,
  clients,
  clientId,
}: {
  currentPath: string;
  summary: ReportSummary;
  months: MonthlyReportRow[];
  currency: string;
  clients: Client[];
  clientId: number | null;
}) {
  const years = groupByYear(months);

  return (
    <Layout title="Reports" currentPath={currentPath}>
      <div class="page-head">
        <h1 class="page-title">Reports</h1>
        <div class="actions">
          {clients.length > 1 ? (
            <form method="get" action="/admin/reports" class="client-filter">
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
          <a class="btn btn-secondary btn-sm" href="/admin/export/invoices.csv">
            Export invoices CSV
          </a>
          <a class="btn btn-secondary btn-sm" href="/admin/export/payments.csv">
            Export payments CSV
          </a>
        </div>
      </div>

      <div class="stat-grid">
        <div class="card stat">
          <span class="stat-label">Outstanding</span>
          <span class="stat-value">{formatCents(summary.outstanding_cents, currency)}</span>
          <span class="muted">
            {summary.outstanding_count} open invoice{summary.outstanding_count === 1 ? '' : 's'}
          </span>
        </div>
        <div class="card stat">
          <span class="stat-label">Overdue</span>
          <span class={`stat-value${summary.overdue_count > 0 ? ' stat-alert' : ''}`}>{summary.overdue_count}</span>
          <span class="muted">past due date</span>
        </div>
        <div class="card stat">
          <span class="stat-label">Received this year</span>
          <span class="stat-value">{formatCents(summary.received_ytd_cents, currency)}</span>
          <span class="muted">all providers</span>
        </div>
      </div>

      {years.length === 0 ? (
        <div class="empty-state">
          <p>{clientId ? 'No activity for this client yet.' : 'Nothing to report yet — send an invoice first.'}</p>
        </div>
      ) : (
        years.map((g) => (
          <div class="card">
            <h2>{g.year}</h2>
            <table class="table table--stack">
              <thead>
                <tr>
                  <th>Month</th>
                  <th class="text-right">Invoices sent</th>
                  <th class="text-right">Invoiced</th>
                  <th class="text-right">Payments</th>
                  <th class="text-right">Received</th>
                </tr>
              </thead>
              <tbody>
                {g.rows.map((r) => (
                  <tr>
                    <td data-label="Month">{monthLabel(r.ym)}</td>
                    <td class="text-right" data-label="Invoices sent">
                      {r.invoiced_count || <span class="muted">—</span>}
                    </td>
                    <td class="text-right" data-label="Invoiced">
                      {r.invoiced_cents ? formatCents(r.invoiced_cents, currency) : <span class="muted">—</span>}
                    </td>
                    <td class="text-right" data-label="Payments">
                      {r.received_count || <span class="muted">—</span>}
                    </td>
                    <td class="text-right" data-label="Received">
                      {r.received_cents ? formatCents(r.received_cents, currency) : <span class="muted">—</span>}
                    </td>
                  </tr>
                ))}
                <tr class="report-total">
                  <td>Total</td>
                  <td class="text-right" data-label="Invoices sent">
                    {g.totals.invoiced_count}
                  </td>
                  <td class="text-right" data-label="Invoiced">
                    {formatCents(g.totals.invoiced_cents, currency)}
                  </td>
                  <td class="text-right" data-label="Payments">
                    {g.totals.received_count}
                  </td>
                  <td class="text-right" data-label="Received">
                    {formatCents(g.totals.received_cents, currency)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        ))
      )}
    </Layout>
  );
}
