import { Layout } from '../layout';

/** Password-mode login. Shown only when ADMIN_PASSWORD is set and Access isn't. */
export function LoginPage({ error, loggedOut }: { error?: boolean; loggedOut?: boolean }) {
  return (
    <Layout title="Sign in" variant="public">
      <div class="pay-card card login-card">
        <h1 class="page-title">Sign in</h1>
        {loggedOut ? <div class="banner banner-success mt-2">Signed out.</div> : null}
        {error ? <div class="banner banner-error mt-2">Wrong password.</div> : null}
        <form method="post" action="/admin/login" class="mt-2">
          <div class="form-group">
            <label for="password">Admin password</label>
            <input type="password" id="password" name="password" autofocus required autocomplete="current-password" />
            <span class="muted">
              The ADMIN_PASSWORD secret. For stronger, phishing-resistant auth, configure Cloudflare
              Access — it takes over automatically and disables this login.
            </span>
          </div>
          <div class="actions">
            <button type="submit" class="btn btn-primary">
              Sign in
            </button>
          </div>
        </form>
      </div>
    </Layout>
  );
}

/** Fail-closed instructions when neither Access nor a password is configured. */
export function AuthSetupPage() {
  return (
    <Layout title="Admin locked" variant="public">
      <div class="pay-card card login-card">
        <h1 class="page-title">Admin is locked</h1>
        <p class="muted mt-1">
          No authentication is configured, so the admin fails closed. Choose one:
        </p>
        <ol class="mt-2 setup-auth-list">
          <li>
            <strong>Quick start:</strong> set a password secret and reload —
            <code>npx wrangler secret put ADMIN_PASSWORD</code>
          </li>
          <li>
            <strong>Recommended:</strong> configure a Cloudflare Access application for
            <code>/admin</code> and set <code>ACCESS_TEAM_DOMAIN</code> + <code>ACCESS_AUD</code> in
            wrangler.jsonc (see the README). Access disables the password automatically.
          </li>
        </ol>
      </div>
    </Layout>
  );
}
