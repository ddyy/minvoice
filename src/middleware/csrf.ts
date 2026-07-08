import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '../env';

/**
 * CSRF protection for state-changing admin requests.
 *
 * The admin session travels in a cookie (a signed session cookie in password
 * mode, or Cloudflare Access's CF_Authorization in Access mode). Access's
 * cookie is SameSite=None, so a cross-site page could otherwise drive a
 * logged-in admin's browser into POSTing to /admin/* (e.g. swapping the
 * stored Stripe keys). This blocks that.
 *
 * Two signals, checked in order:
 * - Sec-Fetch-Site: sent by all current browsers on every request; anything
 *   other than same-origin/none (a top-level nav or a script on our own page)
 *   is rejected.
 * - Origin: fallback for the rare client without Sec-Fetch-Site — its host
 *   must match the request host.
 *
 * Safe methods (GET/HEAD) pass through untouched.
 */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export const csrfGuard = createMiddleware<AppEnv>(async (c, next) => {
  if (SAFE_METHODS.has(c.req.method)) return next();

  const site = c.req.header('Sec-Fetch-Site');
  if (site) {
    // 'same-origin' = our own fetch/form; 'none' = user typed the URL / bookmark
    if (site === 'same-origin' || site === 'none') return next();
    return c.text('Cross-site request blocked', 403);
  }

  // No Sec-Fetch-Site (old client): fall back to an Origin host check.
  const origin = c.req.header('Origin');
  if (origin) {
    try {
      if (new URL(origin).host === new URL(c.req.url).host) return next();
    } catch {
      /* unparseable Origin → reject */
    }
    return c.text('Cross-site request blocked', 403);
  }

  // Neither header present: a same-origin form POST from a browser that omits
  // both is not something current browsers do; reject to stay closed.
  return c.text('Cross-site request blocked', 403);
});
