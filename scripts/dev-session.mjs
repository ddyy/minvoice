#!/usr/bin/env node
// Mint a valid admin session token for LOCAL testing, without the login form
// and without any bypass route in the app. Recomputes exactly what a real
// password login produces (see src/lib/admin-auth.ts signSession), using the
// ADMIN_PASSWORD already in your local .dev.vars. The password is read at
// runtime and never printed — only the resulting token is emitted.
//
// Usage:
//   node scripts/dev-session.mjs            # prints the token
//   node scripts/dev-session.mjs --cookie   # prints a document.cookie snippet
//   node scripts/dev-session.mjs --path .dev.vars.other
//
// Then in the browser (or an automated browser tool):
//   document.cookie = 'minvoice_admin=<token>; path=/'
// and load /admin — you're signed in. Works only where the app runs with the
// same ADMIN_PASSWORD (i.e. local dev); it grants nothing you couldn't get by
// typing the password.
import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const pathIdx = args.indexOf('--path');
const devVarsPath = pathIdx >= 0 ? args[pathIdx + 1] : '.dev.vars';
const asCookie = args.includes('--cookie');

let contents;
try {
  contents = readFileSync(devVarsPath, 'utf8');
} catch {
  console.error(`Could not read ${devVarsPath} — run from the repo root, or pass --path.`);
  process.exit(1);
}
const match = contents.match(/^\s*ADMIN_PASSWORD=(.*)$/m);
if (!match || !match[1].trim()) {
  console.error(`ADMIN_PASSWORD is not set in ${devVarsPath}.`);
  process.exit(1);
}
const password = match[1].trim();

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const expiresAt = Date.now() + SESSION_TTL_MS;
const keyMaterial = createHash('sha256').update(`minvoice-admin-session:${password}`).digest();
const mac = createHmac('sha256', keyMaterial).update(String(expiresAt)).digest('hex');
const token = `${expiresAt}.${mac}`;

process.stdout.write(asCookie ? `document.cookie = 'minvoice_admin=${token}; path=/'` : token);
process.stdout.write('\n');
