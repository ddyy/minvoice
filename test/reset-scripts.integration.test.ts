/// <reference types="vite/client" />
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import resetSql from '../scripts/reset-env.sql?raw';
import wipeSql from '../scripts/wipe-data.sql?raw';

const DB = env.DB;

/** Run a scripts/*.sql file the way `wrangler d1 execute --file` does: statement by statement. */
async function runSqlFile(sql: string): Promise<void> {
  const statements = sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
  await DB.batch(statements.map((s) => DB.prepare(s)));
}

async function count(table: string): Promise<number> {
  return (await DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n;
}

async function seedOAuthGrant(): Promise<void> {
  await DB.batch([
    DB.prepare(`INSERT INTO oauth_clients (client_id, client_name, redirect_uris, registration_ip)
      VALUES ('mcp_client_test', 'Test client', '["https://client.test/cb"]', 'local')`),
    DB.prepare(`INSERT INTO oauth_codes (code_hash, client_id, redirect_uri, code_challenge, scope, resource, expires_at)
      VALUES ('codehash', 'mcp_client_test', 'https://client.test/cb', 'x', 'mcp:read', 'https://invoice.test/mcp', datetime('now', '+10 minutes'))`),
    DB.prepare(`INSERT INTO oauth_tokens (token_hash, token_type, client_id, family_id, scope, resource, expires_at)
      VALUES ('tokenhash', 'refresh', 'mcp_client_test', 'fam1', 'mcp:read', 'https://invoice.test/mcp', datetime('now', '+30 days'))`),
    DB.prepare(`INSERT INTO clients (name) VALUES ('Acme')`),
    DB.prepare(`UPDATE settings SET setup_complete = 1, business_name = 'Biz' WHERE id = 1`),
  ]);
}

beforeEach(async () => {
  await DB.batch([
    DB.prepare('DELETE FROM oauth_codes'),
    DB.prepare('DELETE FROM oauth_tokens'),
    DB.prepare('DELETE FROM oauth_clients'),
    DB.prepare('DELETE FROM clients'),
  ]);
});

describe('scripts/reset-env.sql (factory reset)', () => {
  it('revokes every MCP connection along with the data and settings', async () => {
    await seedOAuthGrant();
    expect(await count('oauth_tokens')).toBe(1);

    await runSqlFile(resetSql);

    expect(await count('oauth_clients')).toBe(0);
    expect(await count('oauth_codes')).toBe(0);
    expect(await count('oauth_tokens')).toBe(0);
    expect(await count('clients')).toBe(0);
    const settings = await DB.prepare('SELECT setup_complete, business_name FROM settings WHERE id = 1')
      .first<{ setup_complete: number; business_name: string }>();
    expect(settings).toEqual({ setup_complete: 0, business_name: '' }); // wizard re-armed
  });
});

describe('scripts/wipe-data.sql (data-only wipe)', () => {
  it('clears transactional data but keeps settings and MCP grants', async () => {
    await seedOAuthGrant();

    await runSqlFile(wipeSql);

    expect(await count('clients')).toBe(0);
    expect(await count('oauth_clients')).toBe(1);
    expect(await count('oauth_tokens')).toBe(1);
    const settings = await DB.prepare('SELECT setup_complete FROM settings WHERE id = 1').first<{ setup_complete: number }>();
    expect(settings?.setup_complete).toBe(1); // not a factory reset
  });
});
