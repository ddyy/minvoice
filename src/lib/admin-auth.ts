/**
 * Admin auth mode selection + password-session crypto.
 *
 * Three modes, strongest available wins:
 * - 'access':       real Cloudflare Access values configured → JWT verification
 *                   only; the password path is dead code. Setting up Access
 *                   automatically retires the password fallback.
 * - 'password':     ADMIN_PASSWORD secret set → signed-cookie sessions.
 * - 'unconfigured': neither → /admin fails closed with setup instructions.
 */
export type AuthMode = 'access' | 'password' | 'unconfigured';

export function authMode(env: {
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  ADMIN_PASSWORD?: string;
}): AuthMode {
  const team = env.ACCESS_TEAM_DOMAIN ?? '';
  const aud = env.ACCESS_AUD ?? '';
  // Real values only — placeholder text from wrangler.jsonc.example won't match.
  if (team.endsWith('.cloudflareaccess.com') && /^[0-9a-f]{64}$/.test(aud)) return 'access';
  if ((env.ADMIN_PASSWORD ?? '').length > 0) return 'password';
  return 'unconfigured';
}

/**
 * DEV_BYPASS_ACCESS only counts for local dev — a deployed Worker that
 * somehow has the var set (e.g. secrets copied from .dev.vars.example) must
 * NOT run authless. Two local signals, either suffices:
 * - a localhost hostname, or
 * - no cf-ray header: every request that actually traversed the Cloudflare
 *   edge carries one (wrangler dev emulates the configured route host in
 *   request.url, so hostname alone can't identify local dev).
 */
export function devBypassActive(
  env: { DEV_BYPASS_ACCESS?: string },
  req: { url: string; headers: Headers }
): boolean {
  return env.DEV_BYPASS_ACCESS === 'true' && isLocalRequest(req);
}

/** Local dev request: localhost hostname, or no cf-ray (never traversed the edge). */
export function isLocalRequest(req: { url: string; headers: Headers }): boolean {
  const host = new URL(req.url).hostname;
  if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]') return true;
  return !req.headers.get('cf-ray');
}

export const SESSION_COOKIE = 'minvoice_admin';
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const enc = new TextEncoder();

// Key derived from the password: changing ADMIN_PASSWORD invalidates all sessions.
async function sessionKey(password: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(`minvoice-admin-session:${password}`));
  return crypto.subtle.importKey('raw', digest, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Stateless session token: `<expiryMs>.<hmac(expiryMs)>`. */
export async function signSession(password: string, expiresAt: number): Promise<string> {
  const key = await sessionKey(password);
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(String(expiresAt)));
  return `${expiresAt}.${hex(mac)}`;
}

export async function verifySession(
  password: string,
  token: string | undefined,
  now = Date.now()
): Promise<boolean> {
  if (!token) return false;
  const dot = token.indexOf('.');
  if (dot < 1) return false;
  const exp = Number(token.slice(0, dot));
  if (!Number.isFinite(exp) || exp <= now) return false;
  const expected = await signSession(password, exp);
  return timingSafeEqual(token, expected);
}

/** Compare via HMAC under a throwaway key — equality check leaks no timing. */
export async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const key = (await crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ])) as CryptoKey;
  const [ma, mb] = await Promise.all([
    crypto.subtle.sign('HMAC', key, enc.encode(a)),
    crypto.subtle.sign('HMAC', key, enc.encode(b)),
  ]);
  return hex(ma) === hex(mb);
}
