import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CSV, startServer, post, get, wait } from './helpers/server.mjs';
import { startSmtpSink } from './helpers/smtp-sink.mjs';

const TEMPLATE = 'templates/bcci-connect.html';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const smtpEnv = (sink) => ({
  SMTP_HOST: '127.0.0.1',
  SMTP_PORT: String(sink.port),
  EMAIL_FROM: 'Desk <desk@local.test>',
});

async function until(check, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (check()) return;
    await wait(50);
  }
  throw new Error('timed out waiting for the condition');
}

test('POST /api/suppress adds addresses and GET /api/suppression lists them', async (t) => {
  const server = await startServer();
  t.after(server.stop);

  const empty = await get(server.base, '/api/suppression');
  assert.equal(empty.status, 200);
  assert.deepEqual([empty.data.count, empty.data.emails], [0, []]);

  const added = await post(server.base, '/api/suppress', { emails: 'Gone@Example.com\nbye@example.com, nonsense', reason: 'unsubscribe' });
  assert.equal(added.status, 200);
  assert.deepEqual(added.data.added, ['gone@example.com', 'bye@example.com']);
  assert.deepEqual(added.data.invalid, ['nonsense']);
  assert.equal(added.data.count, 2);

  const listArray = await post(server.base, '/api/suppress', { emails: ['GONE@example.com', 'new@example.com'] });
  assert.deepEqual([listArray.data.added, listArray.data.already], [['new@example.com'], ['gone@example.com']]);

  const list = await get(server.base, '/api/suppression');
  assert.deepEqual(list.data.emails, ['bye@example.com', 'gone@example.com', 'new@example.com']);
  assert.match(readFileSync(join(server.workDir, 'suppressed.csv'), 'utf8'), /^email,reason,added\ngone@example\.com,unsubscribe,/);

  assert.equal((await get(server.base, '/api/state')).data.suppression.count, 3);
  assert.equal((await post(server.base, '/api/suppress', { emails: '  ' })).status, 400);
  assert.equal((await post(server.base, '/api/suppress', { emails: 5 })).status, 400);
  assert.equal((await post(server.base, '/api/suppress', { emails: 'nonsense' })).status, 400);
});

test('the suppression file is not offered as a recipient list', async (t) => {
  // Inside data/, where the recipient picker looks.
  const name = `suppressed-test-${process.pid}.csv`;
  const server = await startServer({ env: { SUPPRESSION_FILE: join(ROOT, 'data', name) } });
  t.after(async () => { await server.stop(); rmSync(join(ROOT, 'data', name), { force: true }); });

  await post(server.base, '/api/suppress', { emails: 'gone@example.com' });
  const state = await get(server.base, '/api/state');
  assert.equal(state.data.suppression.path, `data/${name}`);
  assert.ok(state.data.csvs.length > 0);
  assert.equal(state.data.csvs.some((c) => c.name === name), false);
});

test('preview and send honour the suppression list, and the message is bulk-compliant', async (t) => {
  const sink = await startSmtpSink();
  const server = await startServer({ env: smtpEnv(sink) });
  t.after(async () => { await server.stop(); await sink.close(); });
  const base = server.base;

  await post(base, '/api/suppress', { emails: 'one@example.com' });

  const preview = await post(base, '/api/preview', { csv: CSV, html: TEMPLATE, subject: 'Hi {{name}}' });
  assert.equal(preview.data.suppressed, 1);
  assert.equal(preview.data.willSend, 3);

  const started = await post(base, '/api/send', { csv: CSV, html: TEMPLATE, subject: 'Hi {{name}}', campaign: 'sup', delay: 0, confirm: true });
  assert.equal(started.status, 202);
  await until(() => sink.messages.length >= 3);
  await wait(300);

  assert.equal(sink.messages.length, 3);
  assert.deepEqual(
    sink.messages.map((m) => m.to[0]).sort(),
    ['<director@example.com>', '<three@example.com>', '<two@example.com>'],
  );
  const raw = sink.messages[0].data.replace(/\r\n[ \t]+/g, ' ');
  assert.match(raw, /^List-Unsubscribe: <mailto:desk@local\.test\?subject=unsubscribe>$/m);
  assert.match(raw, /^Message-ID: <[0-9a-f-]{36}@local\.test>$/m);
  assert.match(raw, /Content-Type: text\/plain/i);
  assert.match(raw, /Content-Type: text\/html/i);
});

test('a scheduled campaign also skips an address suppressed after it was scheduled', async (t) => {
  const sink = await startSmtpSink();
  const server = await startServer({ env: { ...smtpEnv(sink), SCHEDULER_INTERVAL_MS: '200' } });
  t.after(async () => { await server.stop(); await sink.close(); });
  const base = server.base;

  const at = new Date(Date.now() + 2500).toISOString();
  const queued = await post(base, '/api/schedule', { csv: CSV, html: TEMPLATE, subject: 'Hi', campaign: 'later', delay: 0, at });
  assert.equal(queued.status, 201);

  await post(base, '/api/suppress', { emails: 'two@example.com', reason: 'unsubscribe' });
  await until(() => sink.messages.length >= 3, 15000);
  await wait(300);

  assert.equal(sink.messages.length, 3);
  assert.ok(sink.messages.every((m) => m.to[0] !== '<two@example.com>'));
});

test('the test send refuses a suppressed address', async (t) => {
  const sink = await startSmtpSink();
  const server = await startServer({ env: smtpEnv(sink) });
  t.after(async () => { await server.stop(); await sink.close(); });

  await post(server.base, '/api/suppress', { emails: 'me@example.com' });
  const res = await post(server.base, '/api/test', { csv: CSV, html: TEMPLATE, subject: 'Hi', to: 'ME@example.com' });
  assert.equal(res.status, 400);
  assert.match(res.data.error, /on the suppression list/);
  assert.equal(sink.messages.length, 0);
});

test('unusable compliance settings are refused with a clear message before anything is sent', async (t) => {
  const sink = await startSmtpSink();
  t.after(() => sink.close());
  const body = { csv: CSV, html: TEMPLATE, subject: 'Hi', campaign: 'bad', delay: 0, confirm: true };

  for (const [env, pattern] of [
    [{ MAX_PER_HOUR: 'lots' }, /MAX_PER_HOUR must be a whole number/],
    [{ UNSUBSCRIBE_URL: 'http://x.example/u' }, /UNSUBSCRIBE_URL must be an https:\/\/ URL/],
    [{ EMAIL_FROM: 'desk' }, /EMAIL_FROM must be a full address/],
  ]) {
    const server = await startServer({ env: { ...smtpEnv(sink), ...env } });
    try {
      const res = await post(server.base, '/api/send', body);
      assert.equal(res.status, 400);
      assert.match(res.data.error, pattern);
    } finally {
      await server.stop();
    }
  }
  assert.equal(sink.messages.length, 0);
});
