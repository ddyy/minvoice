#!/usr/bin/env node
// Scaffold a Minvoice deployment: download the repo tarball (no git needed),
// install dependencies, and print the setup steps. Zero dependencies — fetch
// and tar cover it (bsdtar ships with macOS, Linux distros, and Windows 10+).

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const TARBALL =
  process.env.MINVOICE_TARBALL ?? 'https://codeload.github.com/ddyy/minvoice/tar.gz/refs/heads/main';

const target = process.argv[2] ?? 'minvoice';
const dir = resolve(process.cwd(), target);

function run(cmd, args, opts = {}) {
  return new Promise((res, rej) => {
    const child = spawn(cmd, args, { stdio: 'inherit', ...opts });
    child.on('error', rej);
    child.on('close', (code) => (code === 0 ? res() : rej(new Error(`${cmd} exited with ${code}`))));
  });
}

function fail(msg) {
  console.error(`\n  ✗ ${msg}\n`);
  process.exit(1);
}

if (existsSync(dir) && readdirSync(dir).length > 0) {
  fail(`${target} already exists and is not empty — pick a new directory.`);
}

console.log(`\n  Minvoice → ${target}\n`);

// 1. Download + extract the repo tarball (strip the repo-name folder wrapper)
mkdirSync(dir, { recursive: true });
console.log('  Downloading…');
const res = await fetch(TARBALL);
if (!res.ok) fail(`download failed: HTTP ${res.status} from GitHub`);
const tar = spawn('tar', ['-xz', '--strip-components=1', '-C', dir], { stdio: ['pipe', 'inherit', 'inherit'] });
const done = new Promise((res2, rej) => {
  tar.on('error', () => rej(new Error('could not run `tar` — install it or clone the repo instead')));
  tar.on('close', (code) => (code === 0 ? res2() : rej(new Error(`tar exited with ${code}`))));
});
const { Readable } = await import('node:stream');
Readable.fromWeb(res.body).pipe(tar.stdin);
await done.catch((e) => fail(e.message));

// The scaffolder itself doesn't belong in a deployment
rmSync(resolve(dir, 'create-minvoice'), { recursive: true, force: true });

// 2. Install dependencies
console.log('\n  Installing dependencies…\n');
await run('npm', ['install'], { cwd: dir, shell: process.platform === 'win32' }).catch(() =>
  fail('npm install failed — run it manually inside the directory')
);

// 3. Generate worker-configuration.d.ts (gitignored, so fresh trees lack it)
await run('npx', ['wrangler', 'types'], { cwd: dir, stdio: 'ignore', shell: process.platform === 'win32' }).catch(
  () => console.warn('  (could not run `npx wrangler types` — run it once before type-checking)')
);

// 4. Fresh git history (best-effort; skipped silently when git is absent)
try {
  await run('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
  await run('git', ['add', '-A'], { cwd: dir, stdio: 'ignore' });
  await run('git', ['commit', '-q', '-m', 'Scaffold Minvoice'], { cwd: dir, stdio: 'ignore' });
} catch {
  /* no git — fine */
}

console.log(`
  Done. Next steps:

    cd ${target}
    npx wrangler d1 create minvoice        # paste the printed id into wrangler.jsonc (database_id)
    npx wrangler secret put ADMIN_PASSWORD # admin login until you set up Cloudflare Access
    npm run deploy                         # migrates the database, deploys to workers.dev

  Local development instead:

    cp .dev.vars.example .dev.vars
    npm run db:migrate:local
    npm run dev                            # http://localhost:8787 — first visit runs the setup wizard

  Docs: https://github.com/ddyy/minvoice#setup
`);
