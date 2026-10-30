#!/usr/bin/env node
/**
 * mailroom — start the local Mailroom server.
 *
 *   mailroom                 bind 127.0.0.1:4173 and open the browser
 *   mailroom --port 5000     another port
 *   mailroom --no-open       do not open a browser
 *   mailroom --host 0.0.0.0  expose on the network (set MAILROOM_PASSWORD!)
 */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;

const args = process.argv.slice(2);
const opts = { open: true };

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--help' || arg === '-h') {
    console.log(`\n  Mailroom ${version}\n
  Usage: mailroom [options]

    --port <n>      port to listen on (default 4173, or $GUI_PORT)
    --host <addr>   interface to bind (default 127.0.0.1, or $GUI_HOST)
    --no-open       do not open a browser
    --open          open a browser (default when one is available)
    --version       print the version
    --help          this message

  Settings are stored in ./.env or ~/.mailroom/config.env and can be
  changed in the browser. Set MAILROOM_PASSWORD before exposing the
  server beyond loopback.

  HTTPS is enabled by pointing MAILROOM_TLS_CERT and MAILROOM_TLS_KEY at
  PEM files. A non-loopback bind over plain HTTP is refused unless
  MAILROOM_ALLOW_INSECURE=1 is set (e.g. behind a trusted TLS proxy).\n`);
    process.exit(0);
  }
  if (arg === '--version' || arg === '-v') {
    console.log(version);
    process.exit(0);
  }
  if (arg === '--no-open') { opts.open = false; continue; }
  if (arg === '--open') { opts.open = true; continue; }
  if (arg === '--port') { process.env.GUI_PORT = args[++i]; continue; }
  if (arg === '--host') { process.env.GUI_HOST = args[++i]; continue; }
  console.error(`Unknown option: ${arg} (try --help)`);
  process.exit(1);
}

// Set before importing: the server reads these at module load.
const { startServer, tlsEnabled } = await import('../src/gui.mjs');
const { resolveConfigPath } = await import('../src/lib/config.mjs');

let address;
try {
  address = await startServer();
} catch (err) {
  console.error(`\n  ${err.message}\n`);
  process.exit(1);
}

const port = typeof address === 'object' && address ? address.port : Number(process.env.GUI_PORT || 4173);
const host = process.env.GUI_HOST || '127.0.0.1';
const shownHost = host === '0.0.0.0' || host === '::' ? 'localhost' : host;
const scheme = tlsEnabled ? 'https' : 'http';
const url = `${scheme}://${shownHost}:${port}/`;

console.log(`\n  Mailroom ${version}`);
console.log(`  ─────────────`);
console.log(`  url       ${url}`);
console.log(`  config    ${resolveConfigPath()}`);
console.log(`\n  Ctrl+C to stop.\n`);

if (opts.open) openBrowser(url);

function openBrowser(target) {
  const [command, argv] = process.platform === 'darwin'
    ? ['open', [target]]
    : process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', target]]
      : ['xdg-open', [target]];

  try {
    const child = spawn(command, argv, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    // No browser on this machine — the URL above is enough.
  }
}
