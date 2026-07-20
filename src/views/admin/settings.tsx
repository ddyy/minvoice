import { Layout } from '../layout';
import { LOCALE_OPTIONS } from '../../lib/strings';
import { currencyOptions, formatTaxRate } from '../../lib/money';
import type { Settings } from '../../db/queries';
import type { ConfigWarning } from '../../lib/config';
import type { KeySource } from '../../lib/providers';

export type ProviderFieldMeta = {
  sources: {
    stripeKey: KeySource;
    stripeWebhook: KeySource;
    paypalId: KeySource;
    paypalSecret: KeySource;
    paypalWebhook: KeySource;
    resend: KeySource;
  };
  /** last-4 of STORED values only — env secret values are never surfaced */
  hints: { stripeKey: string; stripeWebhook: string; paypalSecret: string; resend: string };
  /** PAYPAL_API_BASE var set in wrangler config — the selector is inert then */
  paypalEnvManaged: boolean;
};

export function timezoneOptions(): string[] {
  try {
    // Full IANA list where supported (workerd has it); tiny fallback otherwise.
    return (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.('timeZone') ?? ['UTC'];
  } catch {
    return ['UTC'];
  }
}

export function SettingsPage({
  currentPath,
  settings,
  saved,
  tzKept,
  curKept,
  numKept,
  providerMeta,
  hasLogo,
  emailTestOk,
  emailTestErr,
  resendKept,
  accentKept,
  alerts = [],
  theme = 'auto',
}: {
  currentPath: string;
  settings: Settings;
  saved?: boolean;
  tzKept?: boolean;
  curKept?: boolean;
  numKept?: boolean;
  providerMeta: ProviderFieldMeta;
  hasLogo?: boolean;
  emailTestOk?: string | null;
  emailTestErr?: string | null;
  resendKept?: boolean;
  accentKept?: boolean;
  alerts?: ConfigWarning[];
  /** From the per-browser theme cookie, not Settings (D1) — see /settings/appearance */
  theme?: 'auto' | 'light' | 'dark';
}) {
  const { sources, hints } = providerMeta;
  const taxRatePercent = (settings.tax_rate_bps / 100).toFixed(2);

  return (
    <Layout title="Settings" currentPath={currentPath}>
      <div class="page-head">
        <h1 class="page-title">Settings</h1>
      </div>

      {saved ? <div class="banner banner-success">Settings saved.</div> : null}
      {curKept ? (
        <div class="banner banner-warning">
          That currency isn't supported (unknown code, or a zero-decimal currency like JPY) — the
          previous one was kept.
        </div>
      ) : null}
      {tzKept ? (
        <div class="banner banner-warning">
          The time zone you typed wasn't recognized — the previous one was kept. Pick a suggestion from
          the list.
        </div>
      ) : null}
      {numKept ? (
        <div class="banner banner-warning">
          Next invoice number must be a whole number of 1 or more — the previous value was kept.
        </div>
      ) : null}
      {emailTestOk ? (
        <div class="banner banner-success">Test email sent to {emailTestOk} — check the inbox (and spam).</div>
      ) : null}
      {emailTestErr ? <div class="banner banner-error">Test email failed: {emailTestErr}</div> : null}
      {accentKept ? (
        <div class="banner banner-warning">
          That accent color is too light to stay readable on invoices and emails — the previous color
          was kept. Pick something darker.
        </div>
      ) : null}
      {resendKept ? (
        <div class="banner banner-warning">
          Resend needs an API key before it can be the provider — add the key (Settings → Email) and save
          again. The previous provider was kept.
        </div>
      ) : null}

      <nav class="filter-tabs settings-nav">
        {alerts.length ? <a href="#alerts">Alerts</a> : null}
        <a href="#business">Business</a>
        <a href="#invoicing">Invoicing</a>
        <a href="#email">Email</a>
        <a href="#payments">Payments</a>
        <a href="#appearance">Appearance</a>
      </nav>

      {alerts.length ? (
        <div class="card" id="alerts">
          <h2>Alerts</h2>
          <ul class="warning-list settings-alerts">
            {alerts.map((a) => (
              <li>{a.text}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <form method="post" action="/admin/settings" enctype="multipart/form-data">
        <div class="card" id="business">
          <h2>Business</h2>
          <div class="form-group">
            <label for="business_name">Business name</label>
            <input type="text" id="business_name" name="business_name" value={settings.business_name} required />
          </div>

          <div class="form-group">
            <label for="business_address">Business address</label>
            <textarea id="business_address" name="business_address">
              {settings.business_address}
            </textarea>
            <span class="muted">
              Optional — shown on invoices, the pay page, and PDFs when set. Some jurisdictions
              expect a seller address on invoices.
            </span>
          </div>

          <div class="form-group">
            <label for="business_email">Business email</label>
            <input type="email" id="business_email" name="business_email" value={settings.business_email ?? ''} />
          </div>

          <div class="form-group">
            <label for="logo_file">Logo</label>
            {hasLogo ? (
              <div class="logo-preview">
                <img src="/logo" alt="Current logo" />
                <span class="muted">Current logo</span>
                <label class="logo-remove">
                  <input type="checkbox" name="remove_logo" value="1" /> Remove on save
                </label>
              </div>
            ) : null}
            <input type="file" id="logo_file" name="logo_file" accept="image/png,image/jpeg" />
            <span class="muted">
              PNG or JPEG — stored in your database and shown on the PDF. Uploading replaces the previous
              one. Large images are resized in your browser to fit the 500 KB limit.
            </span>
            <span class="muted" id="logo-resize-note" hidden></span>
          </div>

          <div class="form-group">
            <label for="logo_url">Logo URL (alternative)</label>
            <input type="text" id="logo_url" name="logo_url" value={settings.logo_url ?? ''} />
            <span class="muted">Used only when no logo is uploaded.</span>
          </div>

          <div class="actions">
            <button type="submit" class="btn btn-primary">
              Save settings
            </button>
          </div>
        </div>

        <div class="card" id="invoicing">
          <h2>Invoicing</h2>
          <div class="form-row">
            <div class="form-group">
              <label for="currency">Currency</label>
              <input
                type="text"
                id="currency"
                name="currency"
                value={settings.currency}
                list="currency-list"
                autocomplete="off"
                placeholder="Type to search, e.g. USD"
                required
              />
              <datalist id="currency-list">
                {currencyOptions().map((c) => (
                  <option value={c.code}>{c.name}</option>
                ))}
              </datalist>
            </div>
            <div class="form-group">
              <label for="tax_rate_percent">Tax rate (%)</label>
              <input
                type="number"
                id="tax_rate_percent"
                name="tax_rate_percent"
                step="any"
                min="0"
                value={taxRatePercent}
                required
              />
              <span class="muted">Currently {formatTaxRate(settings.tax_rate_bps)}</span>
            </div>
          </div>

          <div class="form-group">
            <label for="timezone">Time zone</label>
            <input
              type="text"
              id="timezone"
              name="timezone"
              value={settings.timezone}
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
            <span class="muted">
              Business time zone — used for "today" defaults, overdue checks, dated invoice numbers, and
              displayed times. Data is stored in UTC.
            </span>
          </div>

          <div class="form-group">
            <label for="locale">Customer language &amp; region</label>
            <select id="locale" name="locale">
              {LOCALE_OPTIONS.map((l) => (
                <option value={l.tag} selected={l.tag === settings.locale}>
                  {l.label}
                </option>
              ))}
              {LOCALE_OPTIONS.some((l) => l.tag === settings.locale) ? null : (
                <option value={settings.locale} selected>
                  {settings.locale}
                </option>
              )}
              <option value="__custom__">Custom tag…</option>
            </select>
            <input
              type="text"
              id="locale_custom"
              name="locale_custom"
              hidden
              autocomplete="off"
              placeholder="BCP-47 tag, e.g. en-NZ, es-CL, pl"
            />
            <span class="muted">
              Language of everything clients see: invoice emails, the pay page, and the PDF. The region
              variant only changes date and number formatting. Per-client overrides live on each client.
              The admin stays English.
            </span>
          </div>

          <div class="form-group">
            <label for="accent_color">Brand accent color</label>
            <input
              type="color"
              id="accent_color"
              name="accent_color"
              value={settings.accent_color}
              style="width: 3.5rem; height: 2.2rem; padding: 2px; vertical-align: middle;"
            />
            <span class="muted">
              Used for invoice email buttons and links, and the PDF's top band and PAID stamp. Very
              light colors are rejected (they disappear against the page). Defaults to the Ledger green.
            </span>
          </div>

          <div class="form-group">
            <label for="payment_terms_days">Payment terms (days)</label>
            <input
              type="number"
              id="payment_terms_days"
              name="payment_terms_days"
              min="0"
              value={settings.payment_terms_days > 0 ? String(settings.payment_terms_days) : ''}
              placeholder="e.g. 14 for Net 14"
            />
            <span class="muted">
              Prefills the due date as issue date + N days on new invoices. Blank/0 = no default. Clients
              can override it.
            </span>
          </div>

          <div class="form-group">
            <label for="default_rate">Default rate</label>
            <input
              type="text"
              id="default_rate"
              name="default_rate"
              value={settings.default_rate_cents > 0 ? (settings.default_rate_cents / 100).toFixed(2) : ''}
              placeholder="e.g. 150.00"
            />
            <span class="muted">Prefills the unit price of new invoice line items. Clients can override it.</span>
          </div>

          <div class="form-row">
            <div class="form-group">
              <label for="invoice_prefix">Invoice prefix</label>
              <input type="text" id="invoice_prefix" name="invoice_prefix" value={settings.invoice_prefix} required />
              <span class="muted">
                Supports date tokens {'{YYYY} {YY} {MM} {DD}'} — e.g. <code>{'{YYYY}{MM}{DD}'}</code> numbers
                invoices 2026070101, 2026070102… with a per-day counter. Plain prefixes use the global counter.
              </span>
            </div>
            <div class="form-group">
              <label for="next_invoice_number">Next invoice number</label>
              <input
                type="number"
                id="next_invoice_number"
                name="next_invoice_number"
                min="1"
                step="1"
                value={String(settings.next_invoice_number)}
                required
              />
              <span class="muted">
                Counter for plain prefixes (INV- → INV-0042). Dated prefixes number per day and ignore
                it. Rewinding to an already-used number triggers a duplicate warning on the next
                invoice.
              </span>
            </div>
          </div>

          <div class="actions">
            <button type="submit" class="btn btn-primary">
              Save settings
            </button>
          </div>
        </div>
      </form>

      <div class="card" id="email">
        <h2>Email</h2>
        <form method="post" action="/admin/settings/email">
          <div class="form-group">
            <label for="email_provider">Provider</label>
            <select id="email_provider" name="email_provider">
              <option value="none" selected={settings.email_provider === 'none'}>
                No emails — record-keeping only
              </option>
              <option value="cloudflare" selected={settings.email_provider === 'cloudflare'}>
                Cloudflare Email (built-in — Workers Paid plan)
              </option>
              <option value="resend" selected={settings.email_provider === 'resend'}>
                Resend
              </option>
            </select>
            <span class="muted">
              With emails off, invoices are shared by link only; no receipts, notifications, or
              error alerts are sent.
            </span>
            <span id="cloudflare-note" class="muted" hidden={settings.email_provider !== 'cloudflare'}>
              Cloudflare Email Sending requires the <strong>Workers Paid</strong> plan to send to
              clients, plus the <code>send_email</code> binding in wrangler.jsonc. On the free
              plan, use Resend instead.
            </span>
          </div>

          <div id="email-fields" hidden={settings.email_provider === 'none'}>
            <div id="resend-key-wrap" hidden={settings.email_provider !== 'resend'}>
              <SecretField
                name="resend_api_key"
                label="Resend API key"
                source={sources.resend}
                hint={hints.resend}
              />
            </div>

            <div class="form-group">
              <label for="email_from">Email from address</label>
              <input
                type="email"
                id="email_from"
                name="email_from"
                value={settings.email_from}
                placeholder="e.g. invoices@yourdomain.com"
              />
              <span class="muted">
                Sender for all outbound email. Must be on a domain onboarded to Cloudflare Email
                Sending — or verified in Resend when that provider is selected.
              </span>
            </div>

            <div class="form-group provider-toggle reminder-toggle">
              <label>
                <input
                  type="checkbox"
                  id="reminders_enabled"
                  name="reminders_enabled"
                  checked={!!settings.reminders_enabled}
                />
                <span class="provider-toggle-name">Payment reminders</span>
              </label>
              <span class="muted">
                Email clients automatically when an invoice is overdue, on the schedule below. Each
                send appears in the invoice history.
              </span>
            </div>

            <div id="reminder-schedule-wrap" hidden={!settings.reminders_enabled}>
              <div class="form-group">
                <label for="reminder_schedule">Reminder schedule (days overdue)</label>
                <input
                  type="text"
                  id="reminder_schedule"
                  name="reminder_schedule"
                  value={settings.reminder_schedule}
                  placeholder="1, 7, 14"
                />
                <span class="muted">
                  Comma-separated days past due — one reminder per entry, up to 10. The default{' '}
                  <code>1, 7, 14</code> nudges at one day, one week, and two weeks overdue.
                </span>
              </div>
            </div>
          </div>

          <div class="actions">
            <button type="submit" class="btn btn-primary">
              Save email settings
            </button>
          </div>
        </form>

        <form method="post" action="/admin/settings/test-email" class="mt-2">
          <div class="actions">
            <button type="submit" class="btn btn-secondary">
              Send test email
            </button>
            <span class="muted">
              Sends a sample invoice email (with PDF attached) to your business email so you can see
              exactly what clients get — your language, accent color, and logo included. Uses the SAVED
              settings above, so save first if you changed anything.
            </span>
          </div>
        </form>
      </div>

      <div class="card" id="payments">
        <h2>Payments</h2>
        <p class="muted">
          Keys entered here are stored in the database and used only when no{' '}
          <code>wrangler secret</code> exists for the same key — secrets always win and are the
          hardened option (encrypted at rest, excluded from database exports).
        </p>
        <form method="post" action="/admin/settings/providers">
          <div class="provider-toggle">
            <label>
              <input type="checkbox" id="stripe_enabled" name="stripe_enabled" checked={!!settings.stripe_enabled} />
              <span class="provider-toggle-name">Card payments (Stripe)</span>
            </label>
          </div>
          <div class="form-row" id="stripe-fields" hidden={!settings.stripe_enabled}>
            <SecretField
              name="stripe_secret_key"
              label="Stripe secret key"
              source={sources.stripeKey}
              hint={hints.stripeKey}
            />
            <SecretField
              name="stripe_webhook_secret"
              label="Stripe webhook signing secret"
              source={sources.stripeWebhook}
              hint={hints.stripeWebhook}
            />
          </div>

          <div class="provider-toggle">
            <label>
              <input type="checkbox" id="paypal_enabled" name="paypal_enabled" checked={!!settings.paypal_enabled} />
              <span class="provider-toggle-name">PayPal</span>
            </label>
          </div>
          <div id="paypal-fields" hidden={!settings.paypal_enabled}>
            <div class="form-row">
              <PlainCredField
                name="paypal_client_id"
                label="PayPal client ID"
                source={sources.paypalId}
                value={settings.paypal_client_id}
              />
              <SecretField
                name="paypal_client_secret"
                label="PayPal client secret"
                source={sources.paypalSecret}
                hint={hints.paypalSecret}
              />
            </div>
            <div class="form-row">
              <PlainCredField
                name="paypal_webhook_id"
                label="PayPal webhook ID"
                source={sources.paypalWebhook}
                value={settings.paypal_webhook_id}
              />
              <div class="form-group">
                <label for="paypal_environment">PayPal environment</label>
                {providerMeta.paypalEnvManaged ? (
                  <input type="text" id="paypal_environment" disabled placeholder="Managed via wrangler config (PAYPAL_API_BASE)" />
                ) : (
                  <select id="paypal_environment" name="paypal_environment">
                    <option value="live" selected={settings.paypal_environment !== 'sandbox'}>
                      Live
                    </option>
                    <option value="sandbox" selected={settings.paypal_environment === 'sandbox'}>
                      Sandbox (testing)
                    </option>
                  </select>
                )}
              </div>
            </div>
          </div>

          <div class="actions">
            <button type="submit" class="btn btn-primary">
              Save payment settings
            </button>
          </div>
        </form>
      </div>

      <div class="card" id="appearance">
        <h2>Appearance</h2>
        <form method="post" action="/admin/settings/appearance">
          <div class="form-group">
            <label for="theme">Theme</label>
            <select id="theme" name="theme">
              <option value="auto" selected={theme === 'auto'}>
                Auto — match this device
              </option>
              <option value="light" selected={theme === 'light'}>
                Light
              </option>
              <option value="dark" selected={theme === 'dark'}>
                Dark
              </option>
            </select>
            <span class="muted">
              Dashboard only, saved per browser. Invoices, the pay page, and PDFs always stay light.
            </span>
          </div>
          <div class="actions">
            <button type="submit" class="btn btn-primary">
              Save appearance
            </button>
          </div>
        </form>
      </div>

      <script
        dangerouslySetInnerHTML={{
          __html: `
(function () {
  function wire(toggleId, fieldsId) {
    var t = document.getElementById(toggleId), f = document.getElementById(fieldsId);
    t.addEventListener('change', function () { f.hidden = !t.checked; });
  }
  wire('stripe_enabled', 'stripe-fields');
  wire('paypal_enabled', 'paypal-fields');
  wire('reminders_enabled', 'reminder-schedule-wrap');

  var provider = document.getElementById('email_provider');
  var emailFields = document.getElementById('email-fields');
  var resendWrap = document.getElementById('resend-key-wrap');
  var cfNote = document.getElementById('cloudflare-note');
  provider.addEventListener('change', function () {
    emailFields.hidden = provider.value === 'none';
    resendWrap.hidden = provider.value !== 'resend';
    cfNote.hidden = provider.value !== 'cloudflare';
  });

  // Logo: downscale oversized images in the browser so they fit the server's
  // 500 KB cap (Workers have no image codecs; canvas does this for free).
  // PNGs stay PNG to keep transparency; JPEGs step down in quality.
  var localeSel = document.getElementById('locale');
  var localeCustom = document.getElementById('locale_custom');
  if (localeSel && localeCustom) {
    localeSel.addEventListener('change', function () {
      localeCustom.hidden = localeSel.value !== '__custom__';
      if (!localeCustom.hidden) localeCustom.focus();
    });
  }

  var logoInput = document.getElementById('logo_file');
  var logoNote = document.getElementById('logo-resize-note');
  var CAP = 500 * 1024;
  logoInput.addEventListener('change', function () {
    var file = logoInput.files && logoInput.files[0];
    if (!file || file.size <= CAP) { if (logoNote) logoNote.hidden = true; return; }
    var isPng = file.type === 'image/png';
    var img = new Image();
    var url = URL.createObjectURL(file);
    img.onload = function () {
      URL.revokeObjectURL(url);
      var widths = [1000, 700, 500, 350, 250];
      var qualities = isPng ? [1] : [0.85, 0.7, 0.55];
      var attempts = [];
      widths.forEach(function (w) { qualities.forEach(function (q) { attempts.push([w, q]); }); });
      var i = 0;
      function tryNext() {
        if (i >= attempts.length) { if (logoNote) { logoNote.hidden = false; logoNote.textContent = 'Could not shrink this image under 500 KB — please use a smaller file.'; } return; }
        var w = Math.min(attempts[i][0], img.width), q = attempts[i][1];
        i += 1;
        var scale = w / img.width;
        var canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        canvas.toBlob(function (blob) {
          if (!blob) { tryNext(); return; }
          if (blob.size > CAP) { tryNext(); return; }
          var resized = new File([blob], file.name, { type: file.type });
          var dt = new DataTransfer();
          dt.items.add(resized);
          logoInput.files = dt.files;
          if (logoNote) {
            logoNote.hidden = false;
            logoNote.textContent = 'Large image resized to ' + canvas.width + '\u00d7' + canvas.height +
              ' (' + Math.round(blob.size / 1024) + ' KB) before upload.';
          }
        }, file.type, q);
      }
      tryNext();
    };
    img.onerror = function () { URL.revokeObjectURL(url); };
    img.src = url;
  });
})();
`,
        }}
      ></script>
    </Layout>
  );
}

/** Masked credential input: never echoes the stored value; blank = keep. */
function SecretField({
  name,
  label,
  source,
  hint,
}: {
  name: string;
  label: string;
  source: KeySource;
  hint: string;
}) {
  return (
    <div class="form-group">
      <label for={name}>{label}</label>
      {source === 'secret' ? (
        <input type="text" id={name} disabled placeholder="Managed via wrangler secret" />
      ) : (
        <input
          type="password"
          id={name}
          name={name}
          autocomplete="off"
          placeholder={source === 'settings' ? `Configured — ends in ${hint}. Blank keeps it.` : 'Not set'}
        />
      )}
    </div>
  );
}

/** Non-secret credential (ids): value visible and directly editable. */
function PlainCredField({
  name,
  label,
  source,
  value,
}: {
  name: string;
  label: string;
  source: KeySource;
  value: string;
}) {
  return (
    <div class="form-group">
      <label for={name}>{label}</label>
      {source === 'secret' ? (
        <input type="text" id={name} disabled placeholder="Managed via wrangler secret" />
      ) : (
        <input type="text" id={name} name={name} autocomplete="off" value={value} />
      )}
    </div>
  );
}
