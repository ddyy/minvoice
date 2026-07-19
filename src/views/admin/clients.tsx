import { Layout } from '../layout';
import { LOCALE_OPTIONS } from '../../lib/strings';
import { Icon } from '../icons';
import type { Client } from '../../db/queries';

export function ClientsPage({
  currentPath,
  clients,
  error,
}: {
  currentPath: string;
  clients: Client[];
  error?: string;
}) {
  return (
    <Layout title="Clients" currentPath={currentPath}>
      <div class="page-head">
        <h1 class="page-title">Clients</h1>
        <div class="actions">
          <a class="btn btn-primary" href="/admin/clients/new">
            <Icon name="plus" />
            New client
          </a>
        </div>
      </div>

      {error ? <div class="banner banner-error">{error}</div> : null}

      {clients.length === 0 ? (
        <div class="empty-state">
          <p>No clients yet.</p>
        </div>
      ) : (
        <table class="table table--stack">
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Rate</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {clients.map((client) => (
              <tr>
                <td data-label="Name">{client.name}</td>
                <td data-label="Email">{client.email ?? <span class="muted">—</span>}</td>
                <td data-label="Rate">
                  {client.default_rate_cents != null ? (
                    (client.default_rate_cents / 100).toFixed(2)
                  ) : (
                    <span class="muted">default</span>
                  )}
                </td>
                <td data-label="Status">
                  {client.archived ? (
                    <span class="badge badge-void">archived</span>
                  ) : (
                    <span class="badge badge-paid">active</span>
                  )}
                </td>
                <td>
                  <a href={`/admin/clients/${client.id}`}>Edit</a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

    </Layout>
  );
}

export function ClientNewPage({ currentPath }: { currentPath: string }) {
  return (
    <Layout title="New client" currentPath={currentPath}>
      <div class="page-head">
        <h1 class="page-title">New client</h1>
      </div>

      <div class="card">
        <form method="post" action="/admin/clients">
          <div class="form-group">
            <label for="name">Name</label>
            <input type="text" id="name" name="name" required />
          </div>
          <div class="form-group">
            <label for="email">Email</label>
            <input type="email" id="email" name="email" />
          </div>
          <div class="form-group">
            <label for="address">Address</label>
            <textarea id="address" name="address"></textarea>
          </div>
          <div class="form-group">
            <label for="default_rate">Default rate</label>
            <input type="text" id="default_rate" name="default_rate" placeholder="Inherit from settings" />
            <span class="muted">Overrides the settings default rate for this client's invoices.</span>
          </div>
          <div class="form-group">
            <label for="payment_terms_days">Payment terms (days)</label>
            <input type="number" id="payment_terms_days" name="payment_terms_days" min="0" placeholder="Inherit from settings" />
            <span class="muted">Overrides the settings payment terms for this client's invoices.</span>
          </div>
          <div class="form-group">
            <label for="locale">Language &amp; region</label>
            <select id="locale" name="locale">
              <option value="">Inherit from settings</option>
              {LOCALE_OPTIONS.map((l) => (
                <option value={l.tag}>{l.label}</option>
              ))}
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
            <span class="muted">Language for this client's emails, pay page, and PDF.</span>
          </div>
          <div class="actions">
            <button type="submit" class="btn btn-primary">
              Add client
            </button>
            <a class="btn btn-secondary" href="/admin/clients">
              Cancel
            </a>
          </div>
        </form>
      </div>
      <script
        dangerouslySetInnerHTML={{
          __html: `
(function () {
  var sel = document.getElementById('locale'), inp = document.getElementById('locale_custom');
  if (!sel || !inp) return;
  sel.addEventListener('change', function () {
    inp.hidden = sel.value !== '__custom__';
    if (!inp.hidden) inp.focus();
  });
})();
`,
        }}
      ></script>
    </Layout>
  );
}

export function ClientEditPage({ currentPath, client }: { currentPath: string; client: Client }) {
  return (
    <Layout title={`Edit ${client.name}`} currentPath={currentPath}>
      <div class="page-head">
        <h1 class="page-title">Edit client</h1>
      </div>

      <div class="card">
        <form method="post" action={`/admin/clients/${client.id}`}>
          <div class="form-group">
            <label for="name">Name</label>
            <input type="text" id="name" name="name" value={client.name} required />
          </div>
          <div class="form-group">
            <label for="email">Email</label>
            <input type="email" id="email" name="email" value={client.email ?? ''} />
          </div>
          <div class="form-group">
            <label for="address">Address</label>
            <textarea id="address" name="address">
              {client.address ?? ''}
            </textarea>
          </div>
          <div class="form-group">
            <label for="default_rate">Default rate</label>
            <input
              type="text"
              id="default_rate"
              name="default_rate"
              value={client.default_rate_cents != null ? (client.default_rate_cents / 100).toFixed(2) : ''}
              placeholder="Inherit from settings"
            />
            <span class="muted">Overrides the settings default rate for this client's invoices.</span>
          </div>
          <div class="form-group">
            <label for="payment_terms_days">Payment terms (days)</label>
            <input
              type="number"
              id="payment_terms_days"
              name="payment_terms_days"
              min="0"
              value={client.payment_terms_days != null ? String(client.payment_terms_days) : ''}
              placeholder="Inherit from settings"
            />
            <span class="muted">Overrides the settings payment terms for this client's invoices.</span>
          </div>
          <div class="form-group">
            <label for="locale">Language &amp; region</label>
            <select id="locale" name="locale">
              <option value="" selected={!client.locale}>
                Inherit from settings
              </option>
              {LOCALE_OPTIONS.map((l) => (
                <option value={l.tag} selected={l.tag === client.locale}>
                  {l.label}
                </option>
              ))}
              {client.locale && !LOCALE_OPTIONS.some((l) => l.tag === client.locale) ? (
                <option value={client.locale} selected>
                  {client.locale}
                </option>
              ) : null}
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
            <span class="muted">Language for this client's emails, pay page, and PDF.</span>
          </div>
          <div class="form-group">
            <label>
              <input
                type="checkbox"
                name="archived"
                value="1"
                checked={!!client.archived}
                style="width: auto; display: inline-block; margin-right: 8px;"
              />
              Archived
            </label>
          </div>
          <div class="actions">
            <button type="submit" class="btn btn-primary">
              Save changes
            </button>
            <a class="btn btn-secondary" href="/admin/clients">
              Cancel
            </a>
          </div>
        </form>
      </div>
      <script
        dangerouslySetInnerHTML={{
          __html: `
(function () {
  var sel = document.getElementById('locale'), inp = document.getElementById('locale_custom');
  if (!sel || !inp) return;
  sel.addEventListener('change', function () {
    inp.hidden = sel.value !== '__custom__';
    if (!inp.hidden) inp.focus();
  });
})();
`,
        }}
      ></script>
    </Layout>
  );
}
