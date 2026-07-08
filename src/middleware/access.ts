import { createMiddleware } from 'hono/factory';
import { getCookie } from 'hono/cookie';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { AppEnv } from '../env';
import { authMode, devBypassActive, SESSION_COOKIE, verifySession } from '../lib/admin-auth';
import { AuthSetupPage } from '../views/admin/login';

// Lazily initialized once per isolate; jose caches the JWKS and refetches on
// unknown `kid`, so Access key rotation is handled automatically.
let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

/**
 * Admin auth, strongest configured mode wins (see lib/admin-auth.ts):
 * - access: defense-in-depth verification of the Cloudflare Access JWT. Access
 *   gates /admin at the edge; this ensures the Worker never trusts a request
 *   that didn't come through it (workers.dev fallback, misconfigured route).
 * - password: signed session cookie; unauthenticated requests go to /admin/login.
 * - unconfigured: fail closed with setup instructions.
 */
export const accessMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  // Local dev only: .dev.vars sets DEV_BYPASS_ACCESS=true; hostname-gated so
  // it can never disable auth on a deployed Worker.
  if (devBypassActive(c.env, c.req.raw)) return next();

  const mode = authMode(c.env);

  if (mode === 'access') {
    const token = c.req.header('Cf-Access-Jwt-Assertion') ?? getCookie(c, 'CF_Authorization');
    if (!token) return c.text('Forbidden', 403);

    jwks ??= createRemoteJWKSet(new URL(`https://${c.env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`));
    try {
      await jwtVerify(token, jwks, {
        issuer: `https://${c.env.ACCESS_TEAM_DOMAIN}`,
        audience: c.env.ACCESS_AUD,
      });
    } catch {
      return c.text('Forbidden', 403);
    }
    return next();
  }

  if (mode === 'password') {
    if (await verifySession(c.env.ADMIN_PASSWORD!, getCookie(c, SESSION_COOKIE))) return next();
    return c.redirect('/admin/login');
  }

  return c.html(AuthSetupPage(), 403);
});
