import { Layout } from '../layout';
import { timezoneOptions } from './settings';
import { currencyOptions } from '../../lib/money';

export type SetupFormValues = {
  business_name?: string;
  business_email?: string;
  business_address?: string;
  currency?: string;
  timezone?: string;
  invoice_prefix?: string;
  payment_terms_days?: string;
  default_rate?: string;
};

export function SetupPage({ error, values }: { error?: string; values?: SetupFormValues }) {
  const v = values ?? {};
  return (
    <Layout title="Welcome to Minvoice" variant="public">
      <div class="pay-card card">
        <h1 class="page-title">Welcome 👋</h1>
        <p class="muted mt-1">
          Before the first invoice goes out, Minvoice needs a few details. Everything here can be
          changed later in Settings.
        </p>

        {error ? <div class="banner banner-error mt-2">{error}</div> : null}

        <form method="post" action="/admin/setup" class="mt-2">
          <div class="form-group">
            <label for="business_name">Business name *</label>
            <input type="text" id="business_name" name="business_name" value={v.business_name ?? ''} required />
            <span class="muted">Appears on invoices, emails, and the payment page.</span>
          </div>

          <div class="form-group">
            <label for="business_email">Business email *</label>
            <input type="email" id="business_email" name="business_email" value={v.business_email ?? ''} required />
            <span class="muted">
              Reply-to on client emails, and where payment and error notifications go.
            </span>
          </div>

          <div class="form-group">
            <label for="business_address">Business address</label>
            <textarea id="business_address" name="business_address">
              {v.business_address ?? ''}
            </textarea>
          </div>

          <div class="form-row">
            <div class="form-group">
              <label for="currency">Currency *</label>
              <input
                type="text"
                id="currency"
                name="currency"
                value={v.currency ?? 'USD'}
                list="currency-list"
                autocomplete="off"
                required
              />
              <datalist id="currency-list">
                {currencyOptions().map((c) => (
                  <option value={c.code}>{c.name}</option>
                ))}
              </datalist>
            </div>
            <div class="form-group">
              <label for="timezone">Time zone *</label>
              <input
                type="text"
                id="timezone"
                name="timezone"
                value={v.timezone ?? ''}
                list="tz-list"
                autocomplete="off"
                placeholder="Type to search, e.g. America/Los_Angeles"
                required
              />
              <datalist id="tz-list">
                {timezoneOptions().map((tz) => (
                  <option value={tz} />
                ))}
              </datalist>
            </div>
          </div>

          <div class="form-row">
            <div class="form-group">
              <label for="invoice_prefix">Invoice prefix</label>
              <input type="text" id="invoice_prefix" name="invoice_prefix" value={v.invoice_prefix ?? 'INV-'} />
              <span class="muted">Supports date tokens like {'{YYYY}{MM}{DD}'}.</span>
            </div>
            <div class="form-group">
              <label for="payment_terms_days">Payment terms (days)</label>
              <input
                type="number"
                id="payment_terms_days"
                name="payment_terms_days"
                min="0"
                value={v.payment_terms_days ?? ''}
                placeholder="e.g. 14"
              />
            </div>
          </div>

          <div class="form-group">
            <label for="default_rate">Default rate</label>
            <input
              type="text"
              id="default_rate"
              name="default_rate"
              value={v.default_rate ?? ''}
              placeholder="e.g. 150.00"
            />
            <span class="muted">Prefills line-item unit prices. Optional.</span>
          </div>

          <div class="actions mt-2">
            <button type="submit" class="btn btn-primary">
              Finish setup
            </button>
          </div>
        </form>
      </div>
    </Layout>
  );
}
