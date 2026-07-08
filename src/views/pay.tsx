import { Layout } from './layout';
import type { InvoiceItem, InvoiceWithClient, Settings } from '../db/queries';
import { formatCents, formatTaxRate } from '../lib/money';
import { Icon } from './icons';

type Props = {
  invoice: InvoiceWithClient;
  items: InvoiceItem[];
  settings: Settings;
  justPaid: boolean;
  canceled: boolean;
  /** Which payment providers have credentials configured — unconfigured buttons are hidden. */
  providers: { stripe: boolean; paypal: boolean };
};

/**
 * Drafts aren't shown publicly — amounts may still change. The link "goes
 * live" when the invoice is sent; until then the client sees this holding
 * card instead of an unfinished invoice. (Print/PDF sub-routes stay open so
 * the admin's preview buttons work on drafts.)
 */
export function DraftHold({ invoice, settings }: { invoice: InvoiceWithClient; settings: Settings }) {
  return (
    <Layout title={`Invoice ${invoice.number} — ${settings.business_name}`} variant="public">
      <div class="pay-card card error-card">
        <h1 class="error-title">This invoice isn't ready yet</h1>
        <p class="error-note">
          {settings.business_name} is still preparing invoice {invoice.number}. This link will show
          the invoice as soon as it's finalized — check back shortly.
        </p>
      </div>
    </Layout>
  );
}

export function PublicInvoice({ invoice, items, settings, justPaid, providers }: Props) {
  const cur = invoice.currency;
  // Drafts are not payable — amounts may still change before the invoice is sent.
  const payable = invoice.status === 'sent';
  return (
    <Layout title={`Invoice ${invoice.number} — ${settings.business_name}`} variant="public">
      {justPaid && invoice.status !== 'paid' ? (
        <div class="banner banner-success">
          Thank you! Your payment is being confirmed — this page will show it shortly.
        </div>
      ) : null}
      {invoice.status === 'paid' ? (
        <div class="banner banner-success">This invoice has been paid{justPaid ? ' — thank you!' : '.'}</div>
      ) : null}
      {invoice.status === 'void' ? <div class="banner banner-error">This invoice has been voided.</div> : null}

      <div class="pay-card card">
        <div class="page-head">
          <div>
            <h1 class="page-title">{settings.business_name || 'Invoice'}</h1>
            {settings.business_address ? <p class="pay-biz-address muted">{settings.business_address}</p> : null}
            {settings.business_email ? <p class="pay-biz-address muted">{settings.business_email}</p> : null}
          </div>
          <div class="actions">
            {/* Internal statuses (draft/sent) mean nothing to the client — only show settled states. */}
            {invoice.status === 'paid' || invoice.status === 'void' ? (
              <span class={`badge badge-${invoice.status}`}>{invoice.status}</span>
            ) : null}
            <a
              href={`/pay/${invoice.public_token}/print?auto=1`}
              class="btn btn-secondary btn-sm"
              target="_blank"
              rel="noopener"
            >
              <Icon name="printer" />
              Print
            </a>
            <a href={`/pay/${invoice.public_token}/pdf`} class="btn btn-secondary btn-sm">
              <Icon name="download" />
              Download PDF
            </a>
          </div>
        </div>

        <dl class="invoice-meta">
          <div>
            <dt class="muted">Invoice</dt>
            <dd>{invoice.number}</dd>
          </div>
          <div>
            <dt class="muted">Billed to</dt>
            <dd>{invoice.client_name}</dd>
          </div>
          <div>
            <dt class="muted">Issued</dt>
            <dd>{invoice.issue_date}</dd>
          </div>
          {invoice.due_date ? (
            <div>
              <dt class="muted">Due</dt>
              <dd>{invoice.due_date}</dd>
            </div>
          ) : null}
        </dl>

        {invoice.subject ? <p class="pay-subject">{invoice.subject}</p> : null}

        <table class="table">
          <thead>
            <tr>
              <th>Description</th>
              <th class="text-right">Qty</th>
              <th class="text-right">Unit</th>
              <th class="text-right">Amount</th>
            </tr>
          </thead>
          <tbody>
            {items.map((it) => (
              <tr>
                <td class="preline">{it.description}</td>
                <td class="text-right item-dim">{it.quantity}</td>
                <td class="text-right item-dim">{formatCents(it.unit_price_cents, cur)}</td>
                <td class="text-right">{formatCents(it.amount_cents, cur)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div class="totals">
          <div>
            <span class="muted">Subtotal</span> <span>{formatCents(invoice.subtotal_cents, cur)}</span>
          </div>
          {invoice.tax_cents > 0 ? (
            <div>
              <span class="muted">Tax ({formatTaxRate(invoice.tax_rate_bps)})</span>{' '}
              <span>{formatCents(invoice.tax_cents, cur)}</span>
            </div>
          ) : null}
          <div class="totals-final">
            <span>Total</span> <span>{formatCents(invoice.total_cents, cur)}</span>
          </div>
        </div>

        {invoice.notes ? (
          <div class="pay-notes mt-2">
            <span class="pay-notes-label">Notes</span>
            <p>{invoice.notes}</p>
          </div>
        ) : null}

        {payable && (providers.stripe || providers.paypal) ? (
          <div class="pay-buttons mt-2">
            {providers.stripe ? (
              <form method="post" action={`/pay/${invoice.public_token}/stripe`}>
                <button class="btn btn-primary" type="submit">
                  <Icon name="card" />
                  Pay with card
                </button>
              </form>
            ) : null}
            {providers.paypal ? (
              <form method="post" action={`/pay/${invoice.public_token}/paypal`}>
                <button class={providers.stripe ? 'btn btn-secondary' : 'btn btn-primary'} type="submit">
                  Pay with PayPal
                </button>
              </form>
            ) : null}
            <div class="pay-trust">
              <p class="pay-trust-line">
                <Icon name="lock" />
                Payments are secure and encrypted — card details never touch this site.
              </p>
              {providers.stripe ? (
                <p class="pay-trust-detail">
                  Cards are processed by <strong>Stripe</strong>
                  <span class="card-chips" aria-hidden="true">
                    <span>Visa</span>
                    <span>Mastercard</span>
                    <span>Amex</span>
                    <span>Discover</span>
                    <span class="card-chips-more">+ more</span>
                  </span>
                </p>
              ) : null}
              {providers.paypal ? (
                <p class="pay-trust-detail">
                  PayPal payments redirect to <strong>paypal.com</strong> to complete.
                </p>
              ) : null}
            </div>
          </div>
        ) : null}
        {payable && !providers.stripe && !providers.paypal ? (
          <p class="muted mt-2">
            Online payment isn't available for this invoice
            {settings.business_email ? ` — please contact ${settings.business_email}` : ''}.
          </p>
        ) : null}

      </div>
    </Layout>
  );
}
