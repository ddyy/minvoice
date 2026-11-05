import { Layout } from '../layout';
import { formatTimestamp } from '../../lib/dates';
import type { OAuthConnection, OAuthGrant } from '../../routes/oauth';

function GrantStatus({ grant }: { grant: OAuthGrant }) {
  return grant.active
    ? <span class="badge badge-paid">Active</span>
    : <span class="badge badge-void">Revoked or expired</span>;
}

function ShortId({ value }: { value: string }) {
  return <code title={value}>{value.length > 22 ? `${value.slice(0, 12)}…${value.slice(-7)}` : value}</code>;
}

export function ConnectionsPage({
  currentPath,
  connections,
  timezone,
  endpoint,
  staticTokenConfigured,
  revoked,
  removed,
}: {
  currentPath: string;
  connections: OAuthConnection[];
  timezone: string;
  endpoint: string;
  staticTokenConfigured: boolean;
  revoked?: boolean;
  removed?: boolean;
}) {
  return (
    <Layout title="Connections" currentPath={currentPath}>
      <div class="page-head">
        <div>
          <h1 class="page-title">Connections</h1>
          <p class="muted">MCP clients authorized to read or manage this invoicing account.</p>
        </div>
      </div>

      {revoked ? <div class="banner banner-success">Connection access revoked.</div> : null}
      {removed ? <div class="banner banner-success">Client registration removed.</div> : null}
      {staticTokenConfigured ? (
        <div class="banner banner-warning">
          The static MCP token fallback is enabled. Anyone holding that secret bypasses the OAuth grants below;
          rotate or delete <code>MCP_API_TOKEN</code> with Wrangler to remove that access.
        </div>
      ) : null}

      <div class="card">
        <h2>Connect a client</h2>
        <p>Add this Streamable HTTP endpoint in an OAuth-capable MCP client:</p>
        <p><code>{endpoint}</code></p>
        <p class="muted">
          New clients must pass owner login and show a consent screen. Write access includes read access;
          consequential tools still require explicit confirmation.
        </p>
      </div>

      {connections.length === 0 ? (
        <div class="empty-state">
          <p>No clients have registered yet.</p>
        </div>
      ) : connections.map((connection) => (
        <div class="card connection-card">
          <div class="page-head">
            <div>
              <h2>{connection.client_name}</h2>
              <p class="muted">
                Registered {formatTimestamp(connection.created_at, timezone)} · <ShortId value={connection.client_id} />
              </p>
            </div>
            <form method="post" action="/admin/connections/remove" onsubmit="return confirm('Remove this client registration and revoke every grant? The client must register again to reconnect.');">
              <input type="hidden" name="client_id" value={connection.client_id} />
              <button type="submit" class="btn btn-danger btn-sm">Remove client</button>
            </form>
          </div>

          <h3>Redirect URIs</h3>
          <ul class="connection-uri-list">
            {connection.redirect_uris.map((uri) => <li><code>{uri}</code></li>)}
          </ul>

          {connection.grants.length === 0 ? (
            <p class="muted">Registered, but never authorized.</p>
          ) : (
            <table class="table table--stack">
              <thead>
                <tr><th>Status</th><th>Scopes</th><th>Authorized</th><th>Refresh expiry</th><th></th></tr>
              </thead>
              <tbody>
                {connection.grants.map((grant) => (
                  <tr>
                    <td data-label="Status"><GrantStatus grant={grant} /></td>
                    <td data-label="Scopes">{grant.scope.split(' ').map((scope) => <code class="scope-code">{scope}</code>)}</td>
                    <td data-label="Authorized">{formatTimestamp(grant.authorized_at, timezone)}</td>
                    <td data-label="Refresh expiry">
                      {grant.refresh_expires_at ? formatTimestamp(grant.refresh_expires_at, timezone) : '—'}
                    </td>
                    <td data-label="Action" class="text-right">
                      {grant.active ? (
                        <form method="post" action="/admin/connections/revoke">
                          <input type="hidden" name="client_id" value={connection.client_id} />
                          <input type="hidden" name="family_id" value={grant.family_id} />
                          <button type="submit" class="btn btn-secondary btn-sm">Revoke access</button>
                        </form>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ))}
    </Layout>
  );
}
