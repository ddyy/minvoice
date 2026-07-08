import { Layout } from './layout';

/**
 * Public 404 — no DB reads (bots hit this constantly) and no admin nav,
 * since most visitors are clients following a stale or mistyped pay link.
 */
export function NotFoundPage() {
  return (
    <Layout title="Page not found" variant="public">
      <div class="pay-card card error-card">
        <p class="error-code">404</p>
        <h1 class="error-title">This page doesn't exist</h1>
        <p class="error-note">
          The address may have been mistyped, or the link has expired. If you followed a payment
          link from an email, ask whoever sent the invoice for a fresh one.
        </p>
      </div>
    </Layout>
  );
}
