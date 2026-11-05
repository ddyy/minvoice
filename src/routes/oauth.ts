import { Hono } from 'hono';
import type { AppEnv, Bindings } from '../env';
import { accessMiddleware } from '../middleware/access';
import { timingSafeEqual } from '../lib/admin-auth';
import { getSettings } from '../db/queries';

export const MCP_READ_SCOPE = 'mcp:read';
export const MCP_WRITE_SCOPE = 'mcp:write';
const SUPPORTED_SCOPES = [MCP_READ_SCOPE, MCP_WRITE_SCOPE] as const;
const ACCESS_TTL_SECONDS = 60 * 60;
const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60;
const CODE_TTL_SECONDS = 10 * 60;
const REGISTRATION_LIMIT_PER_HOUR = 20;

type OAuthClient = {
  client_id: string;
  client_name: string;
  redirect_uris: string;
};

type OAuthCode = {
  code_hash: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  scope: string;
  resource: string;
  expires_at: string;
  consumed_at: string | null;
};

type OAuthToken = {
  token_hash: string;
  token_type: 'access' | 'refresh';
  client_id: string;
  family_id: string;
  scope: string;
  resource: string;
  expires_at: string;
  revoked_at: string | null;
};

export type OAuthGrant = {
  family_id: string;
  scope: string;
  authorized_at: string;
  access_expires_at: string | null;
  refresh_expires_at: string | null;
  active: boolean;
};

export type OAuthConnection = {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  created_at: string;
  grants: OAuthGrant[];
};

type AuthorizationRequest = {
  client: OAuthClient;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  scope: string;
  resource: string;
};

const encoder = new TextEncoder();

function base64Url(bytes: Uint8Array): string {
  let value = '';
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function randomToken(prefix: string): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `${prefix}${base64Url(bytes)}`;
}

async function sha256(value: string): Promise<string> {
  return base64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))));
}

function origin(c: { req: { url: string } }): string {
  return new URL(c.req.url).origin;
}

function resourceUrl(c: { req: { url: string } }): string {
  return `${origin(c)}/mcp`;
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
}

function oauthError(error: string, description: string, status = 400): Response {
  return json({ error, error_description: description }, status);
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('JSON body must be an object');
  return value as Record<string, unknown>;
}

function validRedirectUri(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.hash || url.username || url.password) return false;
    if (url.protocol === 'https:') return true;
    return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname);
  } catch {
    return false;
  }
}

function normalizedScope(raw: string | null | undefined): string {
  const requested = new Set((raw?.trim() || MCP_READ_SCOPE).split(/\s+/).filter(Boolean));
  for (const scope of requested) {
    if (!SUPPORTED_SCOPES.includes(scope as typeof SUPPORTED_SCOPES[number])) throw new Error(`unsupported scope: ${scope}`);
  }
  if (requested.has(MCP_WRITE_SCOPE)) requested.add(MCP_READ_SCOPE);
  return SUPPORTED_SCOPES.filter((scope) => requested.has(scope)).join(' ');
}

function parseRedirectUris(client: OAuthClient): string[] {
  try {
    const parsed = JSON.parse(client.redirect_uris);
    return Array.isArray(parsed) && parsed.every((value) => typeof value === 'string') ? parsed : [];
  } catch {
    return [];
  }
}

async function authorizationRequest(url: URL, db: D1Database): Promise<AuthorizationRequest> {
  if (url.searchParams.get('response_type') !== 'code') throw new Error('response_type must be code');
  const clientId = url.searchParams.get('client_id') ?? '';
  const client = await db.prepare('SELECT client_id, client_name, redirect_uris FROM oauth_clients WHERE client_id = ?')
    .bind(clientId).first<OAuthClient>();
  if (!client) throw new Error('unknown client_id');
  const redirectUri = url.searchParams.get('redirect_uri') ?? '';
  if (!parseRedirectUris(client).includes(redirectUri)) throw new Error('redirect_uri is not registered for this client');
  if (url.searchParams.get('code_challenge_method') !== 'S256') throw new Error('code_challenge_method must be S256');
  const codeChallenge = url.searchParams.get('code_challenge') ?? '';
  if (!/^[A-Za-z0-9_-]{43}$/.test(codeChallenge)) throw new Error('code_challenge is invalid');
  const resource = url.searchParams.get('resource') ?? '';
  const expectedResource = `${url.origin}/mcp`;
  if (resource !== expectedResource) throw new Error(`resource must be ${expectedResource}`);
  return {
    client,
    redirectUri,
    state: url.searchParams.get('state') ?? '',
    codeChallenge,
    scope: normalizedScope(url.searchParams.get('scope')),
    resource,
  };
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function oauthCookie(request: Request, token: string, maxAge: number): string {
  const secure = new URL(request.url).protocol === 'https:';
  const name = secure ? '__Host-minvoice_oauth_csrf' : 'minvoice_oauth_csrf';
  return `${name}=${token}; HttpOnly; ${secure ? 'Secure; ' : ''}Path=/; SameSite=Lax; Max-Age=${maxAge}`;
}

function readCsrfCookie(request: Request): string {
  const cookie = request.headers.get('Cookie') ?? '';
  for (const part of cookie.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === '__Host-minvoice_oauth_csrf' || name === 'minvoice_oauth_csrf') return rest.join('=');
  }
  return '';
}

function consentPage(business: string, request: AuthorizationRequest, csrf: string): string {
  const scopes = request.scope.split(' ').map((scope) => scope === MCP_WRITE_SCOPE
    ? '<li><strong>Manage invoices</strong> — create, edit, send, void, delete, and record payments</li>'
    : '<li><strong>Read invoicing data</strong> — clients, invoices, payments, reports, and ordinary settings</li>').join('');
  const hidden = [
    ['client_id', request.client.client_id], ['redirect_uri', request.redirectUri], ['state', request.state],
    ['code_challenge', request.codeChallenge], ['code_challenge_method', 'S256'], ['scope', request.scope],
    ['resource', request.resource], ['response_type', 'code'], ['csrf_token', csrf],
  ].map(([name, value]) => `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Authorize ${escapeHtml(request.client.client_name)}</title><style>
body{font-family:system-ui,sans-serif;background:#f4f0e8;color:#1d1a15;margin:0;padding:2rem}.card{max-width:36rem;margin:8vh auto;background:#fff;padding:2rem;border:1px solid #d8d0c2;border-radius:12px;box-shadow:0 12px 35px #352d2015}h1{font-family:Georgia,serif;font-size:1.7rem;margin-top:0}p,li{line-height:1.55}.client{font-weight:700}.actions{display:flex;gap:.75rem;margin-top:1.75rem}button{font:inherit;padding:.7rem 1.1rem;border-radius:6px;border:1px solid #1e5b43;cursor:pointer}.approve{background:#1e5b43;color:#fff}.deny{background:#fff;color:#1d1a15}
</style></head><body><main class="card"><p>${escapeHtml(business || 'Minvoice')}</p><h1>Authorize a connection?</h1>
<p><span class="client">${escapeHtml(request.client.client_name)}</span> is requesting access to this invoicing account.</p><ul>${scopes}</ul>
<p>Only approve if you started this connection. Consequential tools still require confirmation before they run.</p>
<form method="post" action="/oauth/authorize">${hidden}<div class="actions"><button class="approve" name="decision" value="approve">Authorize</button><button class="deny" name="decision" value="deny">Cancel</button></div></form>
</main></body></html>`;
}

function consentHeaders(cookie: string): HeadersInit {
  return {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Set-Cookie': cookie,
    // No form-action directive on purpose: Chrome applies it to the whole
    // redirect chain of a form submission, and approving the consent form
    // answers with a 302 to the client's redirect_uri (a loopback URL for CLI
    // clients), which would be blocked and leave the user on a dead page.
    // The action is fixed server-side and no script can run here, so the
    // directive would guard nothing.
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'X-Robots-Tag': 'noindex',
    'Referrer-Policy': 'no-referrer',
  };
}

function redirectWithError(request: AuthorizationRequest, error: string, description: string): Response {
  const redirect = new URL(request.redirectUri);
  redirect.searchParams.set('error', error);
  redirect.searchParams.set('error_description', description);
  if (request.state) redirect.searchParams.set('state', request.state);
  return Response.redirect(redirect.href, 302);
}

async function issueTokenPair(db: D1Database, clientId: string, familyId: string, scope: string, resource: string) {
  const accessToken = randomToken('mcp_at_');
  const refreshToken = randomToken('mcp_rt_');
  const [accessHash, refreshHash] = await Promise.all([sha256(accessToken), sha256(refreshToken)]);
  await db.batch([
    db.prepare(`INSERT INTO oauth_tokens (token_hash, token_type, client_id, family_id, scope, resource, expires_at)
      VALUES (?, 'access', ?, ?, ?, ?, datetime('now', ?))`)
      .bind(accessHash, clientId, familyId, scope, resource, `+${ACCESS_TTL_SECONDS} seconds`),
    db.prepare(`INSERT INTO oauth_tokens (token_hash, token_type, client_id, family_id, scope, resource, expires_at)
      VALUES (?, 'refresh', ?, ?, ?, ?, datetime('now', ?))`)
      .bind(refreshHash, clientId, familyId, scope, resource, `+${REFRESH_TTL_SECONDS} seconds`),
  ]);
  return { access_token: accessToken, token_type: 'Bearer', expires_in: ACCESS_TTL_SECONDS, refresh_token: refreshToken, scope };
}

export type McpAuthorization = { authorized: true; scopes: Set<string> } | { authorized: false; challenge: string };

export async function authorizeMcpRequest(request: Request, env: Bindings): Promise<McpAuthorization> {
  const authorization = request.headers.get('Authorization') ?? '';
  const rawToken = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  const metadata = `${new URL(request.url).origin}/.well-known/oauth-protected-resource`;
  const challenge = `Bearer resource_metadata="${metadata}", scope="${MCP_READ_SCOPE}"`;
  if (!rawToken) return { authorized: false, challenge };
  if (env.MCP_API_TOKEN && await timingSafeEqual(rawToken, env.MCP_API_TOKEN)) {
    return { authorized: true, scopes: new Set(SUPPORTED_SCOPES) };
  }
  const token = await env.DB.prepare(`SELECT * FROM oauth_tokens
    WHERE token_hash = ? AND token_type = 'access' AND revoked_at IS NULL AND expires_at > datetime('now')`)
    .bind(await sha256(rawToken)).first<OAuthToken>();
  if (!token || token.resource !== resourceUrl({ req: { url: request.url } })) return { authorized: false, challenge };
  return { authorized: true, scopes: new Set(token.scope.split(' ').filter(Boolean)) };
}

export async function purgeExpiredOAuth(db: D1Database): Promise<void> {
  await db.batch([
    db.prepare(`DELETE FROM oauth_codes WHERE expires_at < datetime('now', '-1 day') OR consumed_at < datetime('now', '-1 day')`),
    db.prepare(`DELETE FROM oauth_tokens WHERE expires_at < datetime('now', '-30 days')
      OR revoked_at < datetime('now', '-30 days')`),
    db.prepare(`DELETE FROM oauth_clients
      WHERE created_at < datetime('now', '-30 days')
        AND NOT EXISTS (
          SELECT 1 FROM oauth_tokens
          WHERE oauth_tokens.client_id = oauth_clients.client_id
            AND oauth_tokens.revoked_at IS NULL
            AND oauth_tokens.expires_at > datetime('now')
        )
        AND NOT EXISTS (
          SELECT 1 FROM oauth_codes
          WHERE oauth_codes.client_id = oauth_clients.client_id
            AND oauth_codes.consumed_at IS NULL
            AND oauth_codes.expires_at > datetime('now')
        )`),
  ]);
}

type ConnectionClientRow = OAuthClient & { created_at: string };
type ConnectionTokenRow = Pick<OAuthToken, 'client_id' | 'family_id' | 'scope' | 'token_type' | 'expires_at' | 'revoked_at'> & {
  created_at: string;
  active: number;
};

export async function listOAuthConnections(db: D1Database): Promise<OAuthConnection[]> {
  const [clientsResult, tokensResult] = await db.batch([
    db.prepare(`SELECT client_id, client_name, redirect_uris, created_at FROM oauth_clients ORDER BY created_at DESC`),
    db.prepare(`SELECT client_id, family_id, scope, token_type, expires_at, revoked_at, created_at,
      CASE WHEN revoked_at IS NULL AND expires_at > datetime('now') THEN 1 ELSE 0 END AS active
      FROM oauth_tokens ORDER BY created_at DESC`),
  ]);
  const clients = clientsResult.results as ConnectionClientRow[];
  const tokens = tokensResult.results as ConnectionTokenRow[];
  return clients.map((client) => {
    const families = new Map<string, OAuthGrant>();
    for (const token of tokens) {
      if (token.client_id !== client.client_id) continue;
      let grant = families.get(token.family_id);
      if (!grant) {
        grant = {
          family_id: token.family_id,
          scope: token.scope,
          authorized_at: token.created_at,
          access_expires_at: null,
          refresh_expires_at: null,
          active: false,
        };
        families.set(token.family_id, grant);
      }
      if (token.created_at < grant.authorized_at) grant.authorized_at = token.created_at;
      if (token.token_type === 'access' && (!grant.access_expires_at || token.expires_at > grant.access_expires_at)) {
        grant.access_expires_at = token.expires_at;
      }
      if (token.token_type === 'refresh' && (!grant.refresh_expires_at || token.expires_at > grant.refresh_expires_at)) {
        grant.refresh_expires_at = token.expires_at;
      }
      if (token.active) grant.active = true;
    }
    return {
      client_id: client.client_id,
      client_name: client.client_name,
      redirect_uris: parseRedirectUris(client),
      created_at: client.created_at,
      grants: [...families.values()].sort((a, b) => b.authorized_at.localeCompare(a.authorized_at)),
    };
  });
}

export async function revokeOAuthGrant(db: D1Database, clientId: string, familyId: string): Promise<boolean> {
  const result = await db.prepare(`UPDATE oauth_tokens SET revoked_at = COALESCE(revoked_at, datetime('now'))
    WHERE client_id = ? AND family_id = ?`).bind(clientId, familyId).run();
  return (result.meta.changes ?? 0) > 0;
}

export async function removeOAuthClient(db: D1Database, clientId: string): Promise<boolean> {
  const results = await db.batch([
    db.prepare('DELETE FROM oauth_codes WHERE client_id = ?').bind(clientId),
    db.prepare('DELETE FROM oauth_tokens WHERE client_id = ?').bind(clientId),
    db.prepare('DELETE FROM oauth_clients WHERE client_id = ?').bind(clientId),
  ]);
  return (results[2].meta.changes ?? 0) > 0;
}

export const oauth = new Hono<AppEnv>();

oauth.get('/.well-known/oauth-protected-resource', (c) => json({
  resource: resourceUrl(c),
  authorization_servers: [origin(c)],
  scopes_supported: SUPPORTED_SCOPES,
  bearer_methods_supported: ['header'],
}));
oauth.get('/.well-known/oauth-protected-resource/mcp', (c) => json({
  resource: resourceUrl(c), authorization_servers: [origin(c)], scopes_supported: SUPPORTED_SCOPES, bearer_methods_supported: ['header'],
}));

const authorizationMetadata = (c: Parameters<typeof origin>[0]) => ({
  issuer: origin(c),
  authorization_endpoint: `${origin(c)}/oauth/authorize`,
  token_endpoint: `${origin(c)}/oauth/token`,
  registration_endpoint: `${origin(c)}/oauth/register`,
  revocation_endpoint: `${origin(c)}/oauth/revoke`,
  response_types_supported: ['code'],
  grant_types_supported: ['authorization_code', 'refresh_token'],
  code_challenge_methods_supported: ['S256'],
  token_endpoint_auth_methods_supported: ['none'],
  scopes_supported: SUPPORTED_SCOPES,
});
oauth.get('/.well-known/oauth-authorization-server', (c) => json(authorizationMetadata(c)));

oauth.post('/oauth/register', async (c) => {
  let body: Record<string, unknown>;
  try { body = parseJsonObject(await c.req.json()); }
  catch (error) { return oauthError('invalid_client_metadata', error instanceof Error ? error.message : 'Invalid JSON'); }
  const redirectUris = body.redirect_uris;
  if (!Array.isArray(redirectUris) || redirectUris.length < 1 || redirectUris.length > 10
      || !redirectUris.every((value) => typeof value === 'string' && validRedirectUri(value))) {
    return oauthError('invalid_redirect_uri', 'redirect_uris must contain 1–10 HTTPS or loopback HTTP URLs');
  }
  if (body.token_endpoint_auth_method !== undefined && body.token_endpoint_auth_method !== 'none') {
    return oauthError('invalid_client_metadata', 'only token_endpoint_auth_method none is supported');
  }
  const ip = c.req.header('cf-connecting-ip') ?? 'local';
  const recent = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM oauth_clients
    WHERE registration_ip = ? AND created_at > datetime('now', '-1 hour')`).bind(ip).first<{ n: number }>();
  if ((recent?.n ?? 0) >= REGISTRATION_LIMIT_PER_HOUR) return oauthError('invalid_client_metadata', 'registration rate limit exceeded', 429);
  const clientId = randomToken('mcp_client_');
  const clientName = typeof body.client_name === 'string' ? body.client_name.trim().slice(0, 120) : 'MCP client';
  await c.env.DB.prepare('INSERT INTO oauth_clients (client_id, client_name, redirect_uris, registration_ip) VALUES (?, ?, ?, ?)')
    .bind(clientId, clientName || 'MCP client', JSON.stringify([...new Set(redirectUris)]), ip).run();
  return json({
    client_id: clientId,
    client_name: clientName || 'MCP client',
    redirect_uris: [...new Set(redirectUris)],
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    client_id_issued_at: Math.floor(Date.now() / 1000),
  }, 201);
});

oauth.use('/oauth/authorize', accessMiddleware);

oauth.get('/oauth/authorize', async (c) => {
  let request: AuthorizationRequest;
  try { request = await authorizationRequest(new URL(c.req.url), c.env.DB); }
  catch (error) { return c.text(error instanceof Error ? error.message : 'Invalid authorization request', 400); }
  const csrf = randomToken('csrf_');
  const settings = await getSettings(c.env.DB);
  return new Response(consentPage(settings.business_name, request, csrf), { headers: consentHeaders(oauthCookie(c.req.raw, csrf, CODE_TTL_SECONDS)) });
});

oauth.post('/oauth/authorize', async (c) => {
  const form = await c.req.formData();
  const csrf = String(form.get('csrf_token') ?? '');
  if (!csrf || !(await timingSafeEqual(csrf, readCsrfCookie(c.req.raw)))) {
    return c.text('This authorization page has expired. Go back to your client and start the connection again.', 403);
  }
  const url = new URL(c.req.url);
  for (const key of ['client_id', 'redirect_uri', 'state', 'code_challenge', 'code_challenge_method', 'scope', 'resource', 'response_type']) {
    const value = form.get(key); if (typeof value === 'string') url.searchParams.set(key, value);
  }
  let request: AuthorizationRequest;
  try { request = await authorizationRequest(url, c.env.DB); }
  catch (error) { return c.text(error instanceof Error ? error.message : 'Invalid authorization request', 400); }
  if (form.get('decision') !== 'approve') return redirectWithError(request, 'access_denied', 'The resource owner denied the request');
  const code = randomToken('mcp_code_');
  await c.env.DB.prepare(`INSERT INTO oauth_codes
    (code_hash, client_id, redirect_uri, code_challenge, scope, resource, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now', ?))`)
    .bind(await sha256(code), request.client.client_id, request.redirectUri, request.codeChallenge,
      request.scope, request.resource, `+${CODE_TTL_SECONDS} seconds`).run();
  const redirect = new URL(request.redirectUri);
  redirect.searchParams.set('code', code);
  if (request.state) redirect.searchParams.set('state', request.state);
  // The CSRF cookie is deliberately NOT cleared here. Browsers abandon the
  // first navigation when a form is submitted twice (double click, or a
  // reload-and-resubmit after a slow loopback callback), so the 302 carrying
  // the code is lost and only the second response is shown. With the cookie
  // intact that second submit simply issues a fresh code; the unused one
  // expires in CODE_TTL_SECONDS. The cookie cannot be read cross-site, so
  // keeping it for its remaining lifetime grants nothing to an attacker.
  return new Response(null, {
    status: 302,
    headers: { Location: redirect.href, 'Cache-Control': 'no-store' },
  });
});

oauth.post('/oauth/token', async (c) => {
  const form = await c.req.formData();
  const grantType = String(form.get('grant_type') ?? '');
  const clientId = String(form.get('client_id') ?? '');
  const resource = String(form.get('resource') ?? '');
  if (resource !== resourceUrl(c)) return oauthError('invalid_target', `resource must be ${resourceUrl(c)}`);
  if (grantType === 'authorization_code') {
    const code = String(form.get('code') ?? '');
    const redirectUri = String(form.get('redirect_uri') ?? '');
    const verifier = String(form.get('code_verifier') ?? '');
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return oauthError('invalid_grant', 'code_verifier is invalid');
    const hash = await sha256(code);
    const stored = await c.env.DB.prepare(`SELECT * FROM oauth_codes WHERE code_hash = ? AND consumed_at IS NULL
      AND expires_at > datetime('now')`).bind(hash).first<OAuthCode>();
    if (!stored || stored.client_id !== clientId || stored.redirect_uri !== redirectUri || stored.resource !== resource
        || !(await timingSafeEqual(await sha256(verifier), stored.code_challenge))) {
      return oauthError('invalid_grant', 'authorization code is invalid, expired, or does not match PKCE');
    }
    const consumed = await c.env.DB.prepare(`UPDATE oauth_codes SET consumed_at = datetime('now')
      WHERE code_hash = ? AND consumed_at IS NULL RETURNING code_hash`).bind(hash).first();
    if (!consumed) return oauthError('invalid_grant', 'authorization code was already used');
    return json(await issueTokenPair(c.env.DB, clientId, crypto.randomUUID(), stored.scope, stored.resource));
  }
  if (grantType === 'refresh_token') {
    const raw = String(form.get('refresh_token') ?? '');
    const hash = await sha256(raw);
    const stored = await c.env.DB.prepare(`SELECT * FROM oauth_tokens
      WHERE token_hash = ? AND token_type = 'refresh' AND expires_at > datetime('now')`)
      .bind(hash).first<OAuthToken>();
    if (!stored || stored.client_id !== clientId || stored.resource !== resource) {
      return oauthError('invalid_grant', 'refresh token is invalid or expired');
    }
    if (stored.revoked_at) {
      await c.env.DB.prepare(`UPDATE oauth_tokens SET revoked_at = COALESCE(revoked_at, datetime('now')) WHERE family_id = ?`)
        .bind(stored.family_id).run();
      return oauthError('invalid_grant', 'refresh token reuse detected; the token family was revoked');
    }
    const rotated = await c.env.DB.prepare(`UPDATE oauth_tokens SET revoked_at = datetime('now')
      WHERE token_hash = ? AND revoked_at IS NULL RETURNING token_hash`).bind(hash).first();
    if (!rotated) return oauthError('invalid_grant', 'refresh token was already used');
    return json(await issueTokenPair(c.env.DB, clientId, stored.family_id, stored.scope, stored.resource));
  }
  return oauthError('unsupported_grant_type', 'grant_type must be authorization_code or refresh_token');
});

oauth.post('/oauth/revoke', async (c) => {
  const form = await c.req.formData();
  const raw = String(form.get('token') ?? '');
  if (raw) {
    const token = await c.env.DB.prepare('SELECT * FROM oauth_tokens WHERE token_hash = ?').bind(await sha256(raw)).first<OAuthToken>();
    if (token) await c.env.DB.prepare(`UPDATE oauth_tokens SET revoked_at = COALESCE(revoked_at, datetime('now')) WHERE family_id = ?`)
      .bind(token.family_id).run();
  }
  return new Response(null, { status: 200, headers: { 'Cache-Control': 'no-store' } });
});
