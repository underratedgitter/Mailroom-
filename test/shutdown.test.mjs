import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { startSmtpSink } from './helpers/smtp-sink.mjs';
import { startServer, post, get, wait, CSV } from './helpers/server.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SEND = join(ROOT, 'src/send.mjs');
const TEMPLATE = 'templates/bcci-connect.html';

const exited = (child) => new Promise((done) => {
  if (child.exitCode !== null || child.signalCode !== null) return done({ code: child.exitCode, signal: child.signalCode });
  child.once('exit', (code, signal) => done({ code, signal }));
});

async function until(check, what, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await wait(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const sentLines = (path) => readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  .filter((e) => e.status === 'sent');

/** Runs the real CLI against the sink; the returned handle exposes its output. */
function runCli(dir, sinkPort, extra = []) {
  writeFileSync(join(dir, 'r.csv'), 'email,name\na@example.com,A\nb@example.com,B\nc@example.com,C\nd@example.com,D\n');
  writeFileSync(join(dir, 't.html'), '<p>{{name}}</p>');
  const child = spawn(process.execPath, [
    SEND, '--csv', 'r.csv', '--html', 't.html', '--subject', 'Hi', '--campaign', 'cli-stop',
    '--log', 'sent.jsonl', '--send', ...extra,
  ], {
    cwd: dir,
    env: {
      PATH: process.env.PATH,
      HOME: dir,
      MAILROOM_CONFIG: join(dir, 'none.env'),
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: String(sinkPort),
      SMTP_USER: 'desk@local.test',
      SMTP_PASS: 'x',
      EMAIL_FROM: 'desk@local.test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  return { child, stdout: () => stdout, stderr: () => stderr };
}

for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  test(`CLI: ${signal} between messages stops cleanly, keeps resume state and exits ${code}`, async (t) => {
    const sink = await startSmtpSink();
    const dir = mkdtempSync(join(tmpdir(), 'mailroom-cli-stop-'));
    t.after(async () => { await sink.close(); rmSync(dir, { recursive: true, force: true }); });

    const cli = runCli(dir, sink.port, ['--delay', '3000']);
    await until(() => /\[1\/4\] sent/.test(cli.stdout()), 'the first message');
    cli.child.kill(signal);
    const result = await exited(cli.child);

    assert.equal(result.code, code, cli.stderr());
    assert.match(cli.stderr(), new RegExp(`Interrupted by ${signal}`));
    assert.match(cli.stderr(), /3 recipient\(s\) were not attempted/);
    assert.match(cli.stderr(), /--campaign cli-stop/);
    assert.doesNotMatch(cli.stderr(), /\n\s+at /);
    assert.equal(sink.messages.length, 1);
    assert.deepEqual(sentLines(join(dir, 'sent.jsonl')).map((e) => e.email), ['a@example.com']);

    // Re-running the same campaign carries on where it stopped.
    const again = runCli(dir, sink.port, ['--delay', '0']);
    assert.equal((await exited(again.child)).code, 0, again.stderr());
    assert.match(again.stdout(), /skip +a@example.com/);
    assert.equal(sink.messages.length, 4);
    assert.equal(sentLines(join(dir, 'sent.jsonl')).length, 4);
  });
}

async function configure(base, sinkPort) {
  const saved = await post(base, '/api/settings', {
    host: '127.0.0.1', port: sinkPort, user: 'desk@local.test', pass: 'x', from: 'Desk <desk@local.test>',
  });
  assert.equal(saved.data.ok, true);
}

test('GUI: SIGTERM mid-campaign finishes the message in flight, then exits non-zero with a message', async (t) => {
  const sink = await startSmtpSink();
  const server = await startServer();
  t.after(async () => { await server.stop(); await sink.close(); });
  await configure(server.base, sink.port);

  const started = await post(server.base, '/api/send', {
    csv: CSV, html: TEMPLATE, subject: 'Hi {{name}}', campaign: 'gui-stop', delay: 3000, confirm: true,
  });
  assert.equal(started.status, 202);

  const log = join(server.workDir, 'sent.jsonl');
  await until(() => sink.messages.length >= 1, 'the first message');
  server.child.kill('SIGTERM');
  const result = await exited(server.child);

  assert.equal(result.code, 143, server.output());
  assert.match(server.output(), /Interrupted by SIGTERM/);
  assert.match(server.output(), /gui-stop/);
  assert.match(server.output(), /3 recipient\(s\) were not attempted/);
  assert.equal(sink.messages.length, 1);
  assert.equal(sentLines(log).length, 1);
});

test('GUI: an idle server exits 0 on SIGTERM', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  server.child.kill('SIGTERM');
  assert.deepEqual(await exited(server.child), { code: 0, signal: null });
});

test('GUI: a scheduled send interrupted by SIGTERM goes back in line and resumes after a restart', async (t) => {
  const sink = await startSmtpSink();
  const env = { SCHEDULER_INTERVAL_MS: '100' };
  const first = await startServer({ env });
  const dir = first.workDir;
  let second = null;
  t.after(async () => {
    await first.stop({ keepData: true });
    await second?.stop();
    rmSync(dir, { recursive: true, force: true });
    await sink.close();
  });
  await configure(first.base, sink.port);

  const created = await post(first.base, '/api/schedule', {
    csv: CSV, html: TEMPLATE, subject: 'Sched {{name}}', campaign: 'sched-stop', delay: 3000,
    at: new Date(Date.now() + 1200).toISOString(),
  });
  assert.equal(created.status, 201);
  const id = created.data.entry.id;

  await until(() => sink.messages.length >= 1, 'the first scheduled message');
  first.child.kill('SIGTERM');
  assert.equal((await exited(first.child)).code, 143);

  const stored = JSON.parse(readFileSync(join(dir, 'schedule.json'), 'utf8')).find((e) => e.id === id);
  assert.equal(stored.status, 'pending', 'an interrupted entry is not reported as sent');
  assert.equal(sentLines(join(dir, 'sent.jsonl')).length, 1);

  second = await startServer({ dir, env: { ...env, SCHEDULE_GRACE_MS: String(60 * 60 * 1000) } });
  await configure(second.base, sink.port);
  await until(async () => {
    const entry = (await get(second.base, '/api/schedule')).data.entries.find((e) => e.id === id);
    return entry && entry.status !== 'pending' && entry.status !== 'sending' ? entry : null;
  }, 'the resumed entry', 20000).then((entry) => {
    assert.equal(entry.status, 'sent');
    assert.deepEqual(entry.result, { sent: 3, failed: 0, skipped: 1 });
  });
  assert.equal(sink.messages.length, 4, 'nobody is mailed twice');
});

test('GUI: a scheduled send cancelled by hand is marked cancelled, not sent', async (t) => {
  const sink = await startSmtpSink();
  const server = await startServer({ env: { SCHEDULER_INTERVAL_MS: '100' } });
  t.after(async () => { await server.stop(); await sink.close(); });
  await configure(server.base, sink.port);

  const created = await post(server.base, '/api/schedule', {
    csv: CSV, html: TEMPLATE, subject: 'Sched {{name}}', campaign: 'sched-cancel', delay: 3000,
    at: new Date(Date.now() + 1200).toISOString(),
  });
  assert.equal(created.status, 201);

  const active = await until(async () => (await get(server.base, '/api/jobs/active')).data.jobId, 'the running job');
  await until(() => sink.messages.length >= 1, 'the first message');
  await post(server.base, `/api/jobs/${active}/cancel`, {});

  const entry = await until(async () => {
    const found = (await get(server.base, '/api/schedule')).data.entries.find((e) => e.id === created.data.entry.id);
    return found && found.status !== 'sending' && found.status !== 'pending' ? found : null;
  }, 'the entry to settle');
  assert.equal(entry.status, 'cancelled');
  assert.equal(entry.result.sent, 1);
});
