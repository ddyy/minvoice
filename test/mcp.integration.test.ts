import { env, exports } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { purgeExpiredOAuth } from '../src/routes/oauth';

const DB = env.DB;

type RpcResponse = {
  jsonrpc: '2.0';
  id: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
};

async function rpc(method: string, params?: unknown, token = env.MCP_API_TOKEN): Promise<{ response: Response; body: RpcResponse }> {
  const response = await exports.default.fetch(
    new Request('https://invoice.test/mcp', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params === undefined ? {} : { params }) }),
    })
  );
  const text = await response.text();
  return { response, body: (response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : {}) as RpcResponse };
}

function cookieValue(response: Response): string {
  return response.headers.get('set-cookie')?.split(';')[0] ?? '';
}

function formBody(values: Record<string, string>): string {
  return new URLSearchParams(values).toString();
}

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  let binary = '';
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

async function registerClient(redirectUri = 'https://client.test/callback') {
  const response = await exports.default.fetch(new Request('https://invoice.test/oauth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': `test-${crypto.randomUUID()}` },
    body: JSON.stringify({ client_name: 'Integration client', redirect_uris: [redirectUri], token_endpoint_auth_method: 'none' }),
  }));
  return { response, body: await response.json<{ client_id: string }>(), redirectUri };
}

async function authorizeClient(clientId: string, redirectUri: string, scope: string | null = 'mcp:read mcp:write') {
  const verifier = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~'.slice(0, 64);
  const challenge = await pkceChallenge(verifier);
  const params = new URLSearchParams({
    response_type: 'code', client_id: clientId, redirect_uri: redirectUri, state: 'state-123',
    code_challenge: challenge, code_challenge_method: 'S256', resource: 'https://invoice.test/mcp',
  });
  if (scope !== null) params.set('scope', scope);
  const authorizePath = `/oauth/authorize?${params}`;
  const initial = await exports.default.fetch(new Request(`https://invoice.test${authorizePath}`, { redirect: 'manual' }));
  expect(initial.status).toBe(302);
  const loginUrl = new URL(initial.headers.get('location')!, 'https://invoice.test');
  expect(loginUrl.pathname).toBe('/admin/login');

  const login = await exports.default.fetch(new Request('https://invoice.test/admin/login', {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin' },
    body: formBody({ password: 'integration-test-password', return_to: authorizePath }),
  }));
  const adminCookie = cookieValue(login);
  expect(login.headers.get('location')).toBe(authorizePath);

  const consent = await exports.default.fetch(new Request(`https://invoice.test${authorizePath}`, {
    headers: { cookie: adminCookie }, redirect: 'manual',
  }));
  expect(consent.status).toBe(200);
  const html = await consent.text();
  const csrf = /name="csrf_token" value="([^"]+)"/.exec(html)?.[1] ?? '';
  const csrfCookie = cookieValue(consent);
  expect(csrf).not.toBe('');

  const approval = await exports.default.fetch(new Request('https://invoice.test/oauth/authorize', {
    method: 'POST', redirect: 'manual',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      cookie: `${adminCookie}; ${csrfCookie}`,
    },
    body: formBody({
      response_type: 'code', client_id: clientId, redirect_uri: redirectUri, state: 'state-123',
      code_challenge: challenge, code_challenge_method: 'S256',
      resource: 'https://invoice.test/mcp', csrf_token: csrf, decision: 'approve',
      ...(scope === null ? {} : { scope }),
    }),
  }));
  expect(approval.status).toBe(302);
  const callback = new URL(approval.headers.get('location')!);
  expect(callback.origin + callback.pathname).toBe(redirectUri);
  expect(callback.searchParams.get('state')).toBe('state-123');
  return { code: callback.searchParams.get('code')!, verifier, adminCookie };
}

async function exchangeCode(clientId: string, redirectUri: string, code: string, verifier: string) {
  const response = await exports.default.fetch(new Request('https://invoice.test/oauth/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: formBody({
      grant_type: 'authorization_code', client_id: clientId, redirect_uri: redirectUri,
      code, code_verifier: verifier, resource: 'https://invoice.test/mcp',
    }),
  }));
  return { response, body: await response.json<{ access_token: string; refresh_token: string; scope: string; expires_in: number }>() };
}

async function callTool(name: string, args: Record<string, unknown> = {}) {
  const { response, body } = await rpc('tools/call', { name, arguments: args });
  const result = body.result as { isError?: boolean; structuredContent?: Record<string, unknown>; content: { text: string }[] };
  return { response, body, result };
}

beforeEach(async () => {
  await DB.batch([
    DB.prepare('DELETE FROM email_outbox'),
    DB.prepare('DELETE FROM webhook_events'),
    DB.prepare('DELETE FROM payments'),
    DB.prepare('DELETE FROM invoice_events'),
    DB.prepare('DELETE FROM invoice_items'),
    DB.prepare('DELETE FROM invoices'),
    DB.prepare('DELETE FROM clients'),
    DB.prepare('DELETE FROM oauth_codes'),
    DB.prepare('DELETE FROM oauth_tokens'),
    DB.prepare('DELETE FROM oauth_clients'),
    DB.prepare('DELETE FROM login_attempts'),
    DB.prepare(`UPDATE settings SET business_name = 'Test Business', currency = 'USD', tax_rate_bps = 0,
      timezone = 'UTC', locale = 'en', email_provider = 'none', setup_complete = 1 WHERE id = 1`),
  ]);
});

describe('MCP transport and discovery', () => {
  it('fails closed without the dedicated bearer token', async () => {
    const { response } = await rpc('ping', undefined, 'wrong-token');
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain('resource_metadata="https://invoice.test/.well-known/oauth-protected-resource"');
  });

  it('rejects cross-origin browser requests before reading the bearer token', async () => {
    const response = await exports.default.fetch(new Request('https://invoice.test/mcp', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.MCP_API_TOKEN}`,
        'content-type': 'application/json',
        origin: 'https://attacker.test',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    }));
    expect(response.status).toBe(403);
  });

  it('negotiates the protocol and advertises all capability families', async () => {
    const { response, body } = await rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' },
    });
    expect(response.status).toBe(200);
    expect(body.result?.protocolVersion).toBe('2025-06-18');
    expect(body.result?.capabilities).toEqual({ tools: {}, resources: {}, prompts: {} });
  });

  it('lists tools, resources, templates, and prompts', async () => {
    const tools = await rpc('tools/list');
    expect((tools.body.result?.tools as { name: string }[]).map((tool) => tool.name)).toEqual(
      expect.arrayContaining(['create_client', 'create_invoice', 'send_invoice', 'record_manual_payment', 'get_reports'])
    );
    expect(((await rpc('resources/list')).body.result?.resources as unknown[]).length).toBeGreaterThanOrEqual(4);
    expect(((await rpc('resources/templates/list')).body.result?.resourceTemplates as unknown[]).length).toBe(2);
    expect(((await rpc('prompts/list')).body.result?.prompts as unknown[]).length).toBe(3);
  });

  it('returns a parse error for malformed JSON and no body for notifications', async () => {
    const malformed = await exports.default.fetch(new Request('https://invoice.test/mcp', {
      method: 'POST', headers: { authorization: `Bearer ${env.MCP_API_TOKEN}`, 'content-type': 'application/json' }, body: '{',
    }));
    expect(malformed.status).toBe(400);
    expect((await malformed.json<{ error: { code: number } }>()).error.code).toBe(-32700);

    const notification = await exports.default.fetch(new Request('https://invoice.test/mcp', {
      method: 'POST', headers: { authorization: `Bearer ${env.MCP_API_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    }));
    expect(notification.status).toBe(202);
    expect(await notification.text()).toBe('');
  });
});

describe('MCP OAuth 2.1', () => {
  it('publishes protected-resource and authorization-server metadata', async () => {
    const resource = await exports.default.fetch(new Request('https://invoice.test/.well-known/oauth-protected-resource'));
    expect(await resource.json()).toMatchObject({
      resource: 'https://invoice.test/mcp',
      authorization_servers: ['https://invoice.test'],
      scopes_supported: ['mcp:read', 'mcp:write'],
    });
    const server = await exports.default.fetch(new Request('https://invoice.test/.well-known/oauth-authorization-server'));
    expect(await server.json()).toMatchObject({
      issuer: 'https://invoice.test',
      authorization_endpoint: 'https://invoice.test/oauth/authorize',
      token_endpoint: 'https://invoice.test/oauth/token',
      registration_endpoint: 'https://invoice.test/oauth/register',
      code_challenge_methods_supported: ['S256'],
    });
  });

  it('completes dynamic registration, owner consent, PKCE exchange, and authenticated MCP access', async () => {
    const registered = await registerClient();
    expect(registered.response.status).toBe(201);
    const authorized = await authorizeClient(registered.body.client_id, registered.redirectUri);
    const tokens = await exchangeCode(registered.body.client_id, registered.redirectUri, authorized.code, authorized.verifier);
    expect(tokens.response.status).toBe(200);
    expect(tokens.body).toMatchObject({ scope: 'mcp:read mcp:write', expires_in: 3600 });
    expect(tokens.body.access_token).toMatch(/^mcp_at_/);
    expect(tokens.body.refresh_token).toMatch(/^mcp_rt_/);

    const connected = await rpc('tools/list', undefined, tokens.body.access_token);
    expect(connected.response.status).toBe(200);
    expect((connected.body.result?.tools as { name: string }[]).map((tool) => tool.name)).toContain('create_invoice');

    const replay = await exchangeCode(registered.body.client_id, registered.redirectUri, authorized.code, authorized.verifier);
    expect(replay.response.status).toBe(400);
  });

  it('limits read-only grants and rotates refresh tokens', async () => {
    const registered = await registerClient('https://client.test/read-callback');
    const authorized = await authorizeClient(registered.body.client_id, registered.redirectUri, 'mcp:read');
    const tokens = await exchangeCode(registered.body.client_id, registered.redirectUri, authorized.code, authorized.verifier);
    const listed = await rpc('tools/list', undefined, tokens.body.access_token);
    const names = (listed.body.result?.tools as { name: string }[]).map((tool) => tool.name);
    expect(names).toContain('get_invoice');
    expect(names).not.toContain('create_invoice');
    const forbidden = await rpc('tools/call', { name: 'create_client', arguments: { name: 'Nope' } }, tokens.body.access_token);
    expect(forbidden.response.status).toBe(403);
    expect(forbidden.response.headers.get('www-authenticate')).toContain('scope="mcp:write"');

    const refresh = await exports.default.fetch(new Request('https://invoice.test/oauth/token', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: formBody({ grant_type: 'refresh_token', client_id: registered.body.client_id,
        refresh_token: tokens.body.refresh_token, resource: 'https://invoice.test/mcp' }),
    }));
    const rotated = await refresh.json<{ access_token: string; refresh_token: string }>();
    expect(refresh.status).toBe(200);
    expect(rotated.refresh_token).not.toBe(tokens.body.refresh_token);

    const reuse = await exports.default.fetch(new Request('https://invoice.test/oauth/token', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: formBody({ grant_type: 'refresh_token', client_id: registered.body.client_id,
        refresh_token: tokens.body.refresh_token, resource: 'https://invoice.test/mcp' }),
    }));
    expect(reuse.status).toBe(400);
    const revoked = await rpc('ping', undefined, rotated.access_token);
    expect(revoked.response.status).toBe(401);
  });

  it('defaults an omitted scope to read-only access', async () => {
    const registered = await registerClient('https://client.test/default-scope-callback');
    const authorized = await authorizeClient(registered.body.client_id, registered.redirectUri, null);
    const tokens = await exchangeCode(registered.body.client_id, registered.redirectUri, authorized.code, authorized.verifier);
    expect(tokens.response.status).toBe(200);
    expect(tokens.body.scope).toBe('mcp:read');

    const tools = await rpc('tools/list', undefined, tokens.body.access_token);
    const names = (tools.body.result?.tools as { name: string }[]).map((tool) => tool.name);
    expect(names).toContain('get_invoice');
    expect(names).not.toContain('create_invoice');
  });

  it('rejects refresh tokens that have expired according to the database clock', async () => {
    const registered = await registerClient('https://client.test/expired-refresh-callback');
    const authorized = await authorizeClient(registered.body.client_id, registered.redirectUri, 'mcp:read');
    const tokens = await exchangeCode(registered.body.client_id, registered.redirectUri, authorized.code, authorized.verifier);
    await DB.prepare(`UPDATE oauth_tokens SET expires_at = datetime('now', '-1 second')
      WHERE client_id = ? AND token_type = 'refresh'`).bind(registered.body.client_id).run();

    const refresh = await exports.default.fetch(new Request('https://invoice.test/oauth/token', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: formBody({
        grant_type: 'refresh_token', client_id: registered.body.client_id,
        refresh_token: tokens.body.refresh_token, resource: 'https://invoice.test/mcp',
      }),
    }));
    expect(refresh.status).toBe(400);
    expect(await refresh.json()).toMatchObject({ error: 'invalid_grant' });
  });

  it('purges only abandoned OAuth clients older than 30 days', async () => {
    const clients = [
      ['old-abandoned', '-31 days'],
      ['recent-abandoned', '-29 days'],
      ['old-active-token', '-31 days'],
      ['old-live-code', '-31 days'],
      ['old-expired-token', '-31 days'],
    ] as const;
    for (const [clientId, age] of clients) {
      await DB.prepare(`INSERT INTO oauth_clients
        (client_id, client_name, redirect_uris, registration_ip, created_at)
        VALUES (?, ?, '[]', 'test', datetime('now', ?))`)
        .bind(clientId, clientId, age).run();
    }
    await DB.batch([
      DB.prepare(`INSERT INTO oauth_tokens
        (token_hash, token_type, client_id, family_id, scope, resource, expires_at)
        VALUES ('active-token', 'refresh', 'old-active-token', 'active-family', 'mcp:read',
          'https://invoice.test/mcp', datetime('now', '+1 day'))`),
      DB.prepare(`INSERT INTO oauth_codes
        (code_hash, client_id, redirect_uri, code_challenge, scope, resource, expires_at)
        VALUES ('live-code', 'old-live-code', 'https://client.test/callback', 'challenge', 'mcp:read',
          'https://invoice.test/mcp', datetime('now', '+5 minutes'))`),
      DB.prepare(`INSERT INTO oauth_tokens
        (token_hash, token_type, client_id, family_id, scope, resource, expires_at)
        VALUES ('expired-token', 'refresh', 'old-expired-token', 'expired-family', 'mcp:read',
          'https://invoice.test/mcp', datetime('now', '-31 days'))`),
    ]);

    await purgeExpiredOAuth(DB);

    const remaining = await DB.prepare('SELECT client_id FROM oauth_clients ORDER BY client_id').all<{ client_id: string }>();
    expect(remaining.results.map((row) => row.client_id)).toEqual([
      'old-active-token',
      'old-live-code',
      'recent-abandoned',
    ]);
  });

  it('rejects unregistered redirect URIs and incorrect PKCE verifiers', async () => {
    const registered = await registerClient();
    const login = await exports.default.fetch(new Request('https://invoice.test/admin/login', {
      method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin' },
      body: formBody({ password: 'integration-test-password' }),
    }));
    const badAuthorize = await exports.default.fetch(new Request(
      `https://invoice.test/oauth/authorize?${new URLSearchParams({
        response_type: 'code', client_id: registered.body.client_id, redirect_uri: 'https://attacker.test/callback',
        code_challenge: 'a'.repeat(43), code_challenge_method: 'S256', resource: 'https://invoice.test/mcp',
      })}`,
      { headers: { cookie: cookieValue(login) }, redirect: 'manual' }
    ));
    expect(badAuthorize.status).toBe(400);
    expect(await badAuthorize.text()).toMatch(/redirect_uri/);

    const authorized = await authorizeClient(registered.body.client_id, registered.redirectUri);
    const badToken = await exchangeCode(registered.body.client_id, registered.redirectUri, authorized.code, 'x'.repeat(43));
    expect(badToken.response.status).toBe(400);
    expect((badToken.body as unknown as { error: string }).error).toBe('invalid_grant');
  });

  it('lets the owner inspect, revoke, and remove connections from admin', async () => {
    const registered = await registerClient('https://client.test/manage-callback');
    const authorized = await authorizeClient(registered.body.client_id, registered.redirectUri);
    const tokens = await exchangeCode(registered.body.client_id, registered.redirectUri, authorized.code, authorized.verifier);
    const family = await DB.prepare(`SELECT family_id FROM oauth_tokens WHERE client_id = ? LIMIT 1`)
      .bind(registered.body.client_id).first<{ family_id: string }>();
    expect(family).not.toBeNull();

    const page = await exports.default.fetch(new Request('https://invoice.test/admin/connections', {
      headers: { cookie: authorized.adminCookie },
    }));
    const html = await page.text();
    expect(page.status).toBe(200);
    expect(html).toContain('Integration client');
    expect(html).toContain('https://client.test/manage-callback');
    expect(html).toContain('mcp:write');
    expect(html).toContain('Active');
    expect(html).toContain('static MCP token fallback is enabled');

    const revoked = await exports.default.fetch(new Request('https://invoice.test/admin/connections/revoke', {
      method: 'POST', redirect: 'manual',
      headers: {
        cookie: authorized.adminCookie,
        'content-type': 'application/x-www-form-urlencoded',
        'sec-fetch-site': 'same-origin',
      },
      body: formBody({ client_id: registered.body.client_id, family_id: family!.family_id }),
    }));
    expect(revoked.status).toBe(302);
    expect(revoked.headers.get('location')).toBe('/admin/connections?revoked=1');
    expect((await rpc('ping', undefined, tokens.body.access_token)).response.status).toBe(401);

    const removed = await exports.default.fetch(new Request('https://invoice.test/admin/connections/remove', {
      method: 'POST', redirect: 'manual',
      headers: {
        cookie: authorized.adminCookie,
        'content-type': 'application/x-www-form-urlencoded',
        'sec-fetch-site': 'same-origin',
      },
      body: formBody({ client_id: registered.body.client_id }),
    }));
    expect(removed.status).toBe(302);
    expect(removed.headers.get('location')).toBe('/admin/connections?removed=1');
    expect(await DB.prepare('SELECT client_id FROM oauth_clients WHERE client_id = ?')
      .bind(registered.body.client_id).first()).toBeNull();
    expect(await DB.prepare('SELECT token_hash FROM oauth_tokens WHERE client_id = ?')
      .bind(registered.body.client_id).first()).toBeNull();
  });
});

describe('MCP invoice workflow', () => {
  it('creates a client and invoice, then reads the invoice resource', async () => {
    const clientCall = await callTool('create_client', { name: 'Acme', email: 'ap@acme.test' });
    expect(clientCall.result.isError).not.toBe(true);
    const client = clientCall.result.structuredContent?.client as { id: number };

    const invoiceCall = await callTool('create_invoice', {
      client_id: client.id,
      issue_date: '2026-07-21',
      due_date: '2026-08-20',
      currency: 'EUR',
      items: [{ description: 'Design work', quantity: 2, unit_price_cents: 12500 }],
    });
    expect(invoiceCall.result.isError).not.toBe(true);
    const invoice = invoiceCall.result.structuredContent?.invoice as { id: number; total_cents: number; currency: string };
    expect(invoice).toMatchObject({ total_cents: 25000, currency: 'EUR' });

    const resource = await rpc('resources/read', { uri: `minvoice://invoices/${invoice.id}` });
    const contents = resource.body.result?.contents as { text: string }[];
    expect(JSON.parse(contents[0].text).invoice.id).toBe(invoice.id);
  });

  it('requires explicit confirmation for status and financial changes', async () => {
    const client = (await callTool('create_client', { name: 'Acme' })).result.structuredContent?.client as { id: number };
    const created = await callTool('create_invoice', {
      client_id: client.id,
      issue_date: '2026-07-21',
      items: [{ description: 'Work', quantity: 1, unit_price_cents: 10000 }],
    });
    const invoice = created.result.structuredContent?.invoice as { id: number };

    const refused = await callTool('send_invoice', { id: invoice.id });
    expect(refused.result.isError).toBe(true);
    expect(refused.result.content[0].text).toMatch(/confirm=true/);

    const sent = await callTool('send_invoice', { id: invoice.id, confirm: true });
    expect((sent.result.structuredContent?.invoice as { status: string }).status).toBe('sent');

    const paid = await callTool('record_manual_payment', { id: invoice.id, note: 'Check 123', confirm: true });
    expect((paid.result.structuredContent?.invoice as { status: string }).status).toBe('paid');
    expect((paid.result.structuredContent?.payments as { note: string }[])[0].note).toBe('Check 123');
  });

  it('returns tool validation failures as MCP tool errors without failing JSON-RPC', async () => {
    const call = await callTool('create_invoice', { client_id: 999, issue_date: 'not-a-date', items: [] });
    expect(call.response.status).toBe(200);
    expect(call.body.error).toBeUndefined();
    expect(call.result.isError).toBe(true);
  });

  it('enforces numeric constraints even when a client ignores the advertised schema', async () => {
    const call = await callTool('create_client', { name: 'Acme', default_rate_cents: -1 });
    expect(call.result.isError).toBe(true);
    expect(call.result.content[0].text).toMatch(/non-negative/);
  });
});

describe('consent form resubmission', () => {
  it('a double submit or reload re-issues a code instead of failing CSRF', async () => {
    // Browsers drop the first navigation when a form is submitted twice, so
    // the response the user sees is the SECOND one. It must also succeed.
    const { body: client, redirectUri } = await registerClient();
    const verifier = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~'.slice(0, 64);
    const challenge = await pkceChallenge(verifier);
    const params = new URLSearchParams({
      response_type: 'code', client_id: client.client_id, redirect_uri: redirectUri, state: 's',
      code_challenge: challenge, code_challenge_method: 'S256', resource: 'https://invoice.test/mcp', scope: 'mcp:read',
    });
    const authorizePath = `/oauth/authorize?${params}`;
    const login = await exports.default.fetch(new Request('https://invoice.test/admin/login', {
      method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin' },
      body: formBody({ password: 'integration-test-password', return_to: authorizePath }),
    }));
    const adminCookie = cookieValue(login);
    const consent = await exports.default.fetch(new Request(`https://invoice.test${authorizePath}`, { headers: { cookie: adminCookie }, redirect: 'manual' }));
    expect(consent.status).toBe(200);
    // Chrome enforces form-action on the post-submit redirect to the client's
    // loopback redirect_uri; the consent CSP must never restrict it.
    expect(consent.headers.get('content-security-policy')).not.toMatch(/form-action/);
    expect(consent.headers.get('content-security-policy')).toMatch(/frame-ancestors 'none'/);
    const csrf = /name="csrf_token" value="([^"]+)"/.exec(await consent.text())?.[1] ?? '';
    const csrfCookie = cookieValue(consent);

    const submit = () => exports.default.fetch(new Request('https://invoice.test/oauth/authorize', {
      method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: `${adminCookie}; ${csrfCookie}` },
      body: formBody({
        response_type: 'code', client_id: client.client_id, redirect_uri: redirectUri, state: 's', scope: 'mcp:read',
        code_challenge: challenge, code_challenge_method: 'S256', resource: 'https://invoice.test/mcp',
        csrf_token: csrf, decision: 'approve',
      }),
    }));
    const first = await submit();
    const second = await submit();
    expect(first.status).toBe(302);
    expect(second.status).toBe(302);
    expect(first.headers.get('set-cookie')).toBeNull(); // the CSRF cookie is left to expire, not cleared
    const code1 = new URL(first.headers.get('location')!).searchParams.get('code')!;
    const code2 = new URL(second.headers.get('location')!).searchParams.get('code')!;
    expect(code1).not.toBe(code2);

    // The code the browser actually delivers is the second one; it must exchange.
    const exchanged = await exchangeCode(client.client_id, redirectUri, code2, verifier);
    expect(exchanged.response.status).toBe(200);
    expect(exchanged.body.access_token).toMatch(/^mcp_at_/);
  });

  it('a stale or missing CSRF cookie still fails, with an actionable message', async () => {
    const { body: client, redirectUri } = await registerClient();
    const r = await exports.default.fetch(new Request('https://invoice.test/oauth/authorize', {
      method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: formBody({ client_id: client.client_id, redirect_uri: redirectUri, csrf_token: 'csrf_forged', decision: 'approve' }),
    }));
    // accessMiddleware runs first: unauthenticated POST is bounced to login, never reaches the consent logic
    expect([302, 403]).toContain(r.status);
    if (r.status === 403) expect(await r.text()).toMatch(/expired/i);
  });
});
