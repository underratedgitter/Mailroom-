// Boots the real HTTP/HTTPS server on a free port with an isolated config and log.
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort } from './smtp-sink.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Synthetic recipients keep fresh-clone tests independent of private CSVs.
mkdirSync(join(ROOT, 'data'), { recursive: true });
const fixtureDir = mkdtempSync(join(ROOT, 'data', '.mailroom-test-'));
export const CSV = `data/${basename(fixtureDir)}/recipients.csv`;
writeFileSync(join(ROOT, CSV), 'email,name,company\n'
  + 'director@example.com,Director,Example Company\n'
  + 'one@example.com,One,Example Company\n'
  + 'two@example.com,Two,Example Company\n'
  + 'three@example.com,Three,Example Company\n');
process.once('exit', () => rmSync(fixtureDir, { recursive: true, force: true }));

// The developer's own settings must never leak into a test.
const INHERITED_ENV = [
  'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'EMAIL_FROM', 'SMTP_SECURE',
  'MAILROOM_PASSWORD', 'MAILROOM_TLS_CERT', 'MAILROOM_TLS_KEY', 'MAILROOM_ALLOW_INSECURE',
  'GUI_ALLOWED_HOSTS', 'SCHEDULE_FILE', 'SCHEDULER_INTERVAL_MS', 'SCHEDULE_GRACE_MS',
];

function serverEnv(workDir, port, env) {
  const childEnv = { ...process.env };
  for (const key of INHERITED_ENV) delete childEnv[key];
  return Object.assign(childEnv, {
    GUI_HOST: '127.0.0.1',
    GUI_PORT: String(port),
    MAILROOM_CONFIG: join(workDir, 'config.env'),
    SEND_LOG: join(workDir, 'sent.jsonl'),
    SCHEDULE_FILE: join(workDir, 'schedule.json'),
    ...env,
  });
}

function spawnServer(workDir, port, env) {
  const child = spawn(process.execPath, [join(ROOT, 'src/gui.mjs')], {
    cwd: ROOT,
    env: serverEnv(workDir, port, env),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  return { child, output: () => output };
}

const schemeFor = (env) => (env.MAILROOM_TLS_CERT && env.MAILROOM_TLS_KEY ? 'https' : 'http');

export async function startServer({ env = {}, dir = null } = {}) {
  const workDir = dir || mkdtempSync(join(tmpdir(), 'mailroom-test-'));
  const port = await freePort();
  const { child, output } = spawnServer(workDir, port, env);

  const base = `${schemeFor(env)}://127.0.0.1:${port}`;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited early:\n${output()}`);
    try {
      const res = await fetch(`${base}/api/state`);
      if (res.status < 500) {
        return {
        base,
        port,
        child,
        workDir,
        output,
        stop: (opts = {}) => stop(child, workDir, opts),
      };
      }
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }

  child.kill('SIGKILL');
  throw new Error(`server did not start:\n${output()}`);
}

/**
 * Starts the server with the given environment and waits for it to exit.
 * Used for configuration that must be refused before the port is bound.
 */
export async function expectStartupFailure({ env = {}, timeout = 10000 } = {}) {
  const workDir = mkdtempSync(join(tmpdir(), 'mailroom-refused-'));
  const port = await freePort();
  const { child, output } = spawnServer(workDir, port, env);

  try {
    return await new Promise((resolveDone, rejectDone) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        rejectDone(new Error(`server kept running instead of refusing to start:\n${output()}`));
      }, timeout);
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        resolveDone({ code, signal, output: output() });
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        rejectDone(err);
      });
    });
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

async function stop(child, workDir, { keepData = false } = {}) {
  if (child.exitCode === null) {
    child.kill('SIGTERM');
    await new Promise((resolveDone) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolveDone(); }, 3000);
      child.on('exit', () => { clearTimeout(timer); resolveDone(); });
    });
  }
  if (!keepData) rmSync(workDir, { recursive: true, force: true });
}

export async function post(base, path, body, headers = {}) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data, headers: res.headers };
}

export async function get(base, path, headers = {}) {
  const res = await fetch(`${base}${path}`, { headers, redirect: 'manual' });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data, headers: res.headers };
}

export const wait = (ms) => new Promise((r) => setTimeout(r, ms));
