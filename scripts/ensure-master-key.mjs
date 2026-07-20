#!/usr/bin/env node
// Ensures a SETTINGS_MASTER_KEY secret exists so credentials entered in the
// Settings dashboard are envelope-encrypted in D1 (see src/lib/secretbox.ts).
// Runs after `wrangler deploy` — the Worker must exist before secrets can be
// set. Best-effort: a failure warns but never fails the deploy (the app falls
// back to plaintext storage and shows a Settings alert until the key exists).
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const envFlags = process.argv.slice(2); // e.g. --env test
const shell = process.platform === 'win32';

try {
  const list = execFileSync('npx', ['wrangler', 'secret', 'list', ...envFlags], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell,
  });
  if (list.includes('SETTINGS_MASTER_KEY')) process.exit(0);
  execFileSync('npx', ['wrangler', 'secret', 'put', 'SETTINGS_MASTER_KEY', ...envFlags], {
    input: randomBytes(32).toString('base64'),
    stdio: ['pipe', 'inherit', 'inherit'],
    shell,
  });
  console.log('Generated SETTINGS_MASTER_KEY — API keys entered in Settings are now encrypted at rest.');
} catch (e) {
  console.warn(
    `Could not verify/set SETTINGS_MASTER_KEY (${e?.message ?? e}) — dashboard-entered API keys stay unencrypted until it exists.`
  );
}
