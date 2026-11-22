import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { startSmtpSink } from './helpers/smtp-sink.mjs';

const SEND = resolve(dirname(fileURLToPath(import.meta.url)), '../src/send.mjs');

// Preview mode renders locally and never opens an SMTP connection.
function runPreview(extraArgs, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mailroom-cli-'));
  try {
    writeFileSync(join(dir, 'r.csv'), 'email,name\na@example.com,Ann\nb@example.com,Bob\n');
    writeFileSync(join(dir, 't.html'), '<p>{{name}}</p>');
    return spawnSync(process.execPath, [
      SEND, '--csv', 'r.csv', '--html', 't.html', '--subject', 'Hi', ...extraArgs,
    ], {
      cwd: dir,
      encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: dir, MAILROOM_CONFIG: join(dir, 'none.env'), ...env },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('CLI rejects a non-numeric or negative --delay instead of disabling throttling', () => {
  for (const value of ['abc', '-5', 'NaN', '']) {
    const res = runPreview([`--delay=${value}`]);
    assert.equal(res.status, 1, `--delay "${value}"`);
    assert.match(res.stderr, /--delay must be a whole number of milliseconds/);
  }
});

test('CLI rejects an invalid --limit', () => {
  for (const value of ['abc', '-3', '0', 'NaN']) {
    const res = runPreview([`--limit=${value}`]);
    assert.equal(res.status, 1, `--limit "${value}"`);
    assert.match(res.stderr, /--limit must be a whole number of at least 1/);
  }
});

test('CLI reports a flag value that looks like another option as a plain error', () => {
  const res = runPreview(['--delay', '-5']);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /^\s*Error: .*--delay/);
  assert.doesNotMatch(res.stderr, /\n\s+at /);
});

test('CLI --send without credentials names every missing SMTP setting', () => {
  const res = runPreview(['--send']);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /SMTP_USER/);
  assert.match(res.stderr, /SMTP_PASS/);
  assert.doesNotMatch(res.stderr, /\n\s+at /);
});

test('CLI refuses an invalid SMTP_PORT before connecting', () => {
  const res = runPreview(['--send'], { SMTP_USER: 'a@b.co', SMTP_PASS: 'x', SMTP_PORT: 'abc' });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /SMTP_PORT/);
  assert.match(res.stderr, /"abc"/);
});

test('CLI reports an unreadable template as a plain error', () => {
  const res = runPreview(['--html', '.']);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /Cannot read template/);
  assert.doesNotMatch(res.stderr, /\n\s+at /);
});

test('CLI accepts valid numeric flags, including an explicit --delay 0', () => {
  const res = runPreview(['--delay', '0', '--limit', '1']);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /delay\s+0ms between sends/);
  assert.match(res.stdout, /Rendered 1 recipient/);
});

// The sink lives in this process, so a CLI that talks to it must run asynchronously.
async function runCli(args, { env = {}, files = {}, collect = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mailroom-cli-'));
  try {
    writeFileSync(join(dir, 'r.csv'), 'email,name\na@example.com,Ann\nb@example.com,Bob\nc@example.com,Cy\n');
    writeFileSync(join(dir, 't.html'), '<p>Hi {{name}}</p>');
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, name)), { recursive: true });
      writeFileSync(join(dir, name), text);
    }
    const child = spawn(process.execPath, [SEND, ...args], {
      cwd: dir,
      env: { PATH: process.env.PATH, HOME: dir, MAILROOM_CONFIG: join(dir, 'none.env'), ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const status = await new Promise((done) => child.on('close', done));
    const read = (name) => { try { return readFileSync(join(dir, name), 'utf8'); } catch { return null; } };
    return { status, stdout, stderr, written: Object.fromEntries(collect.map((name) => [name, read(name)])) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const SEND_ARGS = ['--csv', 'r.csv', '--html', 't.html', '--subject', 'Hi', '--delay', '0'];
const smtpEnv = (sink) => ({ SMTP_HOST: '127.0.0.1', SMTP_PORT: String(sink.port), EMAIL_FROM: 'Desk <desk@news.example.org>' });

test('--suppress adds addresses to the suppression list without needing a campaign', async () => {
  const res = await runCli(['--suppress', 'Gone@Example.com, b@example.com'], { collect: ['data/suppressed.csv'] });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /suppressed 2 address/);
  assert.match(res.written['data/suppressed.csv'], /^email,reason,added\ngone@example\.com,manual,.*\nb@example\.com,manual,/);

  const custom = await runCli(['--suppress', 'x@example.com', '--suppression-file', 'out/list.csv'], { collect: ['out/list.csv'] });
  assert.equal(custom.status, 0, custom.stderr);
  assert.match(custom.written['out/list.csv'], /x@example\.com/);
});

test('--suppress without an address is an error', async () => {
  const res = await runCli(['--suppress', '']);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /--suppress needs at least one address/);
});

test('--suppress reports an address it cannot use and exits non-zero', async () => {
  const res = await runCli(['--suppress', 'good@example.com,nonsense']);
  assert.equal(res.status, 1);
  assert.match(res.stdout, /suppressed 1 address/);
  assert.match(res.stderr, /not an email address: nonsense/);
});

test('preview says how many recipients the suppression list will hold back', async () => {
  const res = await runCli(SEND_ARGS, { files: { 'data/suppressed.csv': 'email,reason,added\nB@example.com,unsubscribe,2026-01-01\n' } });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /suppressed\s+1 \(will skip\)/);
});

test('--send never mails a suppressed address', async (t) => {
  const sink = await startSmtpSink();
  t.after(() => sink.close());
  const res = await runCli([...SEND_ARGS, '--send'], {
    env: smtpEnv(sink),
    files: { 'data/suppressed.csv': 'email,reason,added\nb@example.com,unsubscribe,2026-01-01\n' },
  });

  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.deepEqual(sink.messages.map((m) => m.to[0]), ['<a@example.com>', '<c@example.com>']);
  assert.match(res.stdout, /skip\s+b@example\.com \(suppressed\)/);
  assert.match(res.stdout, /sent\s+2/);
  assert.match(res.stdout, /suppressed\s+1/);
  assert.match(sink.messages[0].data, /List-Unsubscribe: <mailto:desk@news\.example\.org\?subject=unsubscribe>/);
});

test('--test refuses a suppressed address', async (t) => {
  const sink = await startSmtpSink();
  t.after(() => sink.close());
  const res = await runCli([...SEND_ARGS, '--test', 'me@example.com'], {
    env: smtpEnv(sink),
    files: { 'data/suppressed.csv': 'me@example.com\n' },
  });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /me@example\.com is on the suppression list/);
  assert.equal(sink.messages.length, 0);
});

test('--send stops before connecting when the compliance settings are unusable', async (t) => {
  const sink = await startSmtpSink();
  t.after(() => sink.close());

  const rate = await runCli([...SEND_ARGS, '--send'], { env: { ...smtpEnv(sink), MAX_PER_HOUR: 'lots' } });
  assert.equal(rate.status, 1);
  assert.match(rate.stderr, /MAX_PER_HOUR must be a whole number/);

  const url = await runCli([...SEND_ARGS, '--send'], { env: { ...smtpEnv(sink), UNSUBSCRIBE_URL: 'http://x.example/u' } });
  assert.equal(url.status, 1);
  assert.match(url.stderr, /UNSUBSCRIBE_URL must be an https:\/\/ URL/);

  const from = await runCli([...SEND_ARGS, '--send'], { env: { ...smtpEnv(sink), EMAIL_FROM: 'desk' } });
  assert.equal(from.status, 1);
  assert.match(from.stderr, /EMAIL_FROM must be a full address/);
  assert.equal(sink.messages.length, 0);
});

test('--send reports a message the server may have accepted as unconfirmed and never resends it', async (t) => {
  const sink = await startSmtpSink({ stall: (envelope) => (envelope.to[0].startsWith('<b@') ? 'drop' : false) });
  t.after(() => sink.close());
  const res = await runCli([...SEND_ARGS, '--send', '--campaign', 'c1'], { env: smtpEnv(sink) });

  assert.equal(res.status, 1, res.stdout + res.stderr);
  assert.equal(sink.messages.filter((m) => m.to[0] === '<b@example.com>').length, 1);
  assert.match(res.stdout, /UNCONFIRMED b@example\.com/);
  assert.match(res.stdout, /unconfirmed\s+1/);
  assert.match(res.stdout, /sent\s+2/);
  assert.match(res.stdout, /failed\s+0/);
});
