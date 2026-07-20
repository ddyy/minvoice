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

type CurrencyTotals = Omit<MonthlyReportRow, 'ym'>;

type YearGroup = {
  year: string;
  rows: MonthlyReportRow[];
  /** One totals line per currency — never summed across currencies */
  totals: CurrencyTotals[];
};

function groupByYear(rows: MonthlyReportRow[]): YearGroup[] {
  const groups: YearGroup[] = [];
  for (const r of rows) {
    const year = r.ym.slice(0, 4);
    let g = groups[groups.length - 1];
    if (!g || g.year !== year) {
      g = { year, rows: [], totals: [] };
      groups.push(g);
    }
    g.rows.push(r);
    let t = g.totals.find((t) => t.currency === r.currency);
    if (!t) {
      t = { currency: r.currency, invoiced_count: 0, invoiced_cents: 0, received_count: 0, received_cents: 0 };
      g.totals.push(t);
    }
    t.invoiced_count += r.invoiced_count;
    t.invoiced_cents += r.invoiced_cents;
    t.received_count += r.received_count;
    t.received_cents += r.received_cents;
  }
  for (const g of groups) g.totals.sort((a, b) => (a.currency < b.currency ? -1 : 1));
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
  // Settings currency first, then alphabetical; zero row so empty tiles still render
  const sums = summary.by_currency.length
    ? [...summary.by_currency].sort((a, b) =>
        a.currency === currency ? -1 : b.currency === currency ? 1 : a.currency < b.currency ? -1 : 1
      )
    : [{ currency, outstanding_cents: 0, received_ytd_cents: 0 }];
  // Currency column/labels only appear once a second currency exists
  const multiCurrency = new Set([...months.map((r) => r.currency), ...sums.map((s) => s.currency)]).size > 1;

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
          {sums.map((s) => (
            <span class="stat-value">{formatCents(s.outstanding_cents, s.currency)}</span>
          ))}
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
          {sums.map((s) => (
            <span class="stat-value">{formatCents(s.received_ytd_cents, s.currency)}</span>
          ))}
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
                  {multiCurrency ? <th>Currency</th> : null}
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
                    {multiCurrency ? <td data-label="Currency">{r.currency}</td> : null}
                    <td class="text-right" data-label="Invoices sent">
                      {r.invoiced_count || <span class="muted">—</span>}
                    </td>
                    <td class="text-right" data-label="Invoiced">
                      {r.invoiced_cents ? formatCents(r.invoiced_cents, r.currency) : <span class="muted">—</span>}
                    </td>
                    <td class="text-right" data-label="Payments">
                      {r.received_count || <span class="muted">—</span>}
                    </td>
                    <td class="text-right" data-label="Received">
                      {r.received_cents ? formatCents(r.received_cents, r.currency) : <span class="muted">—</span>}
                    </td>
                  </tr>
                ))}
                {g.totals.map((t) => (
                  <tr class="report-total">
                    <td>Total</td>
                    {multiCurrency ? <td data-label="Currency">{t.currency}</td> : null}
                    <td class="text-right" data-label="Invoices sent">
                      {t.invoiced_count}
                    </td>
                    <td class="text-right" data-label="Invoiced">
                      {formatCents(t.invoiced_cents, t.currency)}
                    </td>
                    <td class="text-right" data-label="Payments">
                      {t.received_count}
                    </td>
                    <td class="text-right" data-label="Received">
                      {formatCents(t.received_cents, t.currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))
      )}
    </Layout>
  );
}
