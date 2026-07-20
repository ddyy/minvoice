import { Layout } from './layout';
import type { InvoiceItem, InvoiceWithClient, Settings } from '../db/queries';
import { formatTaxRate } from '../lib/money';
import { formatCentsTag, formatDateTag, getStrings, resolveLocale } from '../lib/strings';
import { Icon } from './icons';

type Props = {
  invoice: InvoiceWithClient;
  items: InvoiceItem[];
  settings: Settings;
  justPaid: boolean;
  canceled: boolean;
  /** Active provider payment that didn't match the invoice — checkout is suppressed (see awaitingPaymentReview) */
  underReview?: boolean;
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
  const tag = resolveLocale(settings.locale, invoice.client_locale);
  const t = getStrings(tag);
  return (
    <Layout title={`${t.invoice} ${invoice.number} — ${settings.business_name}`} variant="public" lang={tag}>
      <div class="pay-card card error-card">
        <h1 class="error-title">{t.draftHoldTitle}</h1>
        <p class="error-note">{t.draftHoldBody(settings.business_name, invoice.number)}</p>
      </div>
    </Layout>
  );
}

export function PublicInvoice({ invoice, items, settings, justPaid, underReview, providers }: Props) {
  const cur = invoice.currency;
  const tag = resolveLocale(settings.locale, invoice.client_locale);
  const t = getStrings(tag);
  const money = (cents: number) => formatCentsTag(cents, cur, tag);
  // Drafts are not payable — amounts may still change before the invoice is sent.
  const payable = invoice.status === 'sent';
  return (
    <Layout title={`${t.invoice} ${invoice.number} — ${settings.business_name}`} variant="public" lang={tag}>
      {underReview ? (
        <div class="banner banner-warning">{t.paymentUnderReview}</div>
      ) : justPaid && invoice.status !== 'paid' ? (
        <div class="banner banner-success">
          {t.paymentConfirming}
        </div>
      ) : null}
      {invoice.status === 'paid' ? (
        <div class="banner banner-success">{justPaid ? t.invoicePaidThanks : t.invoicePaid}</div>
      ) : null}
      {invoice.status === 'void' ? <div class="banner banner-error">{t.invoiceVoided}</div> : null}

      <div class="pay-card card">
        <div class="page-head">
          <div>
            <h1 class="page-title">{settings.business_name || t.invoice}</h1>
            {settings.business_address ? <p class="pay-biz-address muted">{settings.business_address}</p> : null}
            {settings.business_email ? <p class="pay-biz-address muted">{settings.business_email}</p> : null}
          </div>
          <div class="actions">
            {/* Internal statuses (draft/sent) mean nothing to the client — only show settled states. */}
            {invoice.status === 'paid' || invoice.status === 'void' ? (
              <span class={`badge badge-${invoice.status}`}>
                {invoice.status === 'paid' ? t.paid : t.statusVoid.toLocaleLowerCase(tag)}
              </span>
            ) : null}
            <a
              href={`/pay/${invoice.public_token}/print?auto=1`}
              class="btn btn-secondary btn-sm"
              target="_blank"
              rel="noopener"
            >
              <Icon name="printer" />
              {t.print}
            </a>
            <a href={`/pay/${invoice.public_token}/pdf`} class="btn btn-secondary btn-sm">
              <Icon name="download" />
              {t.downloadPdf}
            </a>
          </div>
        </div>

        <dl class="invoice-meta">
          <div>
            <dt class="muted">{t.invoice}</dt>
            <dd>{invoice.number}</dd>
          </div>
          <div>
            <dt class="muted">{t.billedTo}</dt>
            <dd>{invoice.client_name}</dd>
          </div>
          <div>
            <dt class="muted">{t.issued}</dt>
            <dd>{formatDateTag(invoice.issue_date, tag)}</dd>
          </div>
          {invoice.due_date ? (
            <div>
              <dt class="muted">{t.due}</dt>
              <dd>{formatDateTag(invoice.due_date, tag)}</dd>
            </div>
          ) : null}
        </dl>

        {invoice.subject ? <p class="pay-subject">{invoice.subject}</p> : null}

        <table class="table">
          <thead>
            <tr>
              <th>{t.description}</th>
              <th class="text-right">{t.qty}</th>
              <th class="text-right">{t.unitPrice}</th>
              <th class="text-right">{t.amount}</th>
            </tr>
          </thead>
          <tbody>
            {items.map((it) => (
              <tr>
                <td class="preline">{it.description}</td>
                <td class="text-right item-dim">{it.quantity}</td>
                <td class="text-right item-dim">{money(it.unit_price_cents)}</td>
                <td class="text-right">{money(it.amount_cents)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div class="totals">
          <div>
            <span class="muted">{t.subtotal}</span> <span>{money(invoice.subtotal_cents)}</span>
          </div>
          {invoice.tax_cents > 0 ? (
            <div>
              <span class="muted">{t.tax} ({formatTaxRate(invoice.tax_rate_bps)})</span>{' '}
              <span>{money(invoice.tax_cents)}</span>
            </div>
          ) : null}
          <div class="totals-final">
            <span>{t.total}</span> <span>{money(invoice.total_cents)}</span>
          </div>
        </div>

        {invoice.notes ? (
          <div class="pay-notes mt-2">
            <span class="pay-notes-label">{t.notes}</span>
            <p>{invoice.notes}</p>
          </div>
        ) : null}

        {payable && (providers.stripe || providers.paypal) ? (
          <div class="pay-buttons mt-2">
            {providers.stripe ? (
              <form method="post" action={`/pay/${invoice.public_token}/stripe`}>
                <button class="btn btn-primary" type="submit">
                  <Icon name="card" />
                  {t.payWithCard}
                </button>
              </form>
            ) : null}
            {providers.paypal ? (
              <form method="post" action={`/pay/${invoice.public_token}/paypal`}>
                <button class={providers.stripe ? 'btn btn-secondary' : 'btn btn-primary'} type="submit">
                  {t.payWithPaypal}
                </button>
              </form>
            ) : null}
            <div class="pay-trust">
              <p class="pay-trust-line">
                <Icon name="lock" />
                {t.trustLine}
              </p>
              {providers.stripe ? (
                <p class="pay-trust-detail">
                  {t.trustCardsPrefix} <strong>Stripe</strong>
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
                  {t.trustPaypal}
                </p>
              ) : null}
            </div>
          </div>
        ) : null}
        {payable && !providers.stripe && !providers.paypal ? (
          <p class="muted mt-2">{t.noOnlinePayment(settings.business_email)}</p>
        ) : null}

      </div>
    </Layout>
  );
}
