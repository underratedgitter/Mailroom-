import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
  assert.equal(list.data.entries.length, 3);
  const goneEntry = list.data.entries.find((e) => e.email === 'gone@example.com');
  assert.equal(goneEntry.reason, 'unsubscribe');
  assert.match(goneEntry.added, /^\d{4}-\d\d-\d\dT/);
  assert.match(readFileSync(join(server.workDir, 'suppressed.csv'), 'utf8'), /^email,reason,added\ngone@example\.com,unsubscribe,/);

  assert.equal((await get(server.base, '/api/state')).data.suppression.count, 3);
  assert.equal((await post(server.base, '/api/suppress', { emails: '  ' })).status, 400);
  assert.equal((await post(server.base, '/api/suppress', { emails: 5 })).status, 400);
  assert.equal((await post(server.base, '/api/suppress', { emails: 'nonsense' })).status, 400);
});

test('POST /api/unsuppress removes addresses and makes them eligible again', async (t) => {
  const sink = await startSmtpSink();
  const server = await startServer({ env: smtpEnv(sink) });
  t.after(async () => { await server.stop(); await sink.close(); });

  await post(server.base, '/api/suppress', {
    emails: ['Gone@Example.com', 'stay@example.com'],
    reason: 'bounce',
  });
  const beforeTest = await post(server.base, '/api/test', {
    csv: CSV, html: TEMPLATE, subject: 'Hi', to: 'gone@example.com',
  });
  assert.equal(beforeTest.status, 400);

  const removed = await post(server.base, '/api/unsuppress', { email: 'GONE@example.com' });
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.data.removed, ['gone@example.com']);
  assert.equal(removed.data.count, 1);

  const list = await get(server.base, '/api/suppression');
  assert.deepEqual(list.data.emails, ['stay@example.com']);
  assert.deepEqual(list.data.entries.map((e) => [e.email, e.reason]), [['stay@example.com', 'bounce']]);
  assert.equal((await get(server.base, '/api/state')).data.suppression.count, 1);

  const afterTest = await post(server.base, '/api/test', {
    csv: CSV, html: TEMPLATE, subject: 'Hi', to: 'gone@example.com',
  });
  assert.equal(afterTest.status, 200);
  assert.equal(afterTest.data.ok, true);

  const missing = await post(server.base, '/api/unsuppress', { emails: ['missing@example.com'] });
  assert.equal(missing.status, 200);
  assert.deepEqual(missing.data.removed, []);
  assert.deepEqual(missing.data.notFound, ['missing@example.com']);

  assert.equal((await post(server.base, '/api/unsuppress', { emails: '   ' })).status, 400);
  assert.equal((await post(server.base, '/api/unsuppress', { emails: 5 })).status, 400);
  assert.equal((await post(server.base, '/api/unsuppress', { email: 'not-an-email' })).status, 400);
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
    [{ MAILROOM_PUBLIC_URL: 'http://x.example' }, /MAILROOM_PUBLIC_URL must be an https:\/\/ URL/],
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

test('the preview of every bundled template has a working unsubscribe link and no link warnings', async (t) => {
  const server = await startServer({ env: { SMTP_HOST: '127.0.0.1', SMTP_PORT: '2525', EMAIL_FROM: 'Desk <desk@news.example.org>' } });
  t.after(server.stop);

  for (const name of ['bcci-connect', 'bcci-connect-v2', 'bcci-membership']) {
    const preview = await post(server.base, '/api/preview', { csv: CSV, html: `templates/${name}.html`, subject: 'Hi' });
    assert.equal(preview.status, 200, name);
    assert.deepEqual(preview.data.warnings, [], name);
    assert.doesNotMatch(preview.data.html, /\{\{\s*unsubscribe_url/);
  }
  const v2 = await post(server.base, '/api/preview', { csv: CSV, html: 'templates/bcci-connect-v2.html', subject: 'Hi' });
  assert.match(v2.data.html, /href="mailto:desk@news\.example\.org\?subject=unsubscribe"/);
  const found = Object.fromEntries(v2.data.placeholders.map((p) => [p.name, p.status]));
  assert.equal(found.unsubscribe_url, 'builtin');
});

test('the preview warns when the unsubscribe link cannot work, as on an install with no From address yet', async (t) => {
  const server = await startServer();
  t.after(server.stop);
  const preview = await post(server.base, '/api/preview', { csv: CSV, html: 'templates/bcci-connect-v2.html', subject: 'Hi' });
  assert.equal(preview.status, 200);
  assert.deepEqual(preview.data.warnings.map((w) => w.code), ['placeholder-link', 'no-unsubscribe']);
});

test('a test send carries the unsubscribe link of the test address', async (t) => {
  const sink = await startSmtpSink();
  const server = await startServer({ env: { ...smtpEnv(sink), UNSUBSCRIBE_URL: 'https://news.example.org/u?e={email}' } });
  t.after(async () => { await server.stop(); await sink.close(); });
  const sent = await post(server.base, '/api/test', { csv: CSV, html: 'templates/bcci-connect-v2.html', subject: 'Hi', to: 'me@example.test' });
  assert.equal(sent.data.ok, true, JSON.stringify(sent.data));
  // The body is quoted-printable, so "=" is "=3D".
  assert.match(sink.messages[0].data, /news\.example\.org\/u\?e=3Dme%40example\.test/);
});

test('signed /unsubscribe works without login, keeps GET side-effect-free, suppresses on POST, and persists secret', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mailroom-unsub-'));
  const sink = await startSmtpSink();
  const env = { ...smtpEnv(sink), MAILROOM_PUBLIC_URL: 'https://mail.example.org', MAILROOM_PASSWORD: 'secret-pass' };
  const server = await startServer({ dir, env });
  t.after(async () => { await sink.close(); await server.stop(); rmSync(dir, { recursive: true, force: true }); });

  const login = await post(server.base, '/api/login', { password: 'secret-pass' });
  const cookie = login.headers.get('set-cookie').split(';')[0];

  const preview = await post(server.base, '/api/preview', {
    csv: CSV, html: 'templates/bcci-connect-v2.html', subject: 'Hi',
  }, { cookie });
  assert.equal(preview.status, 200);
  assert.deepEqual(preview.data.warnings, []);
  const mPrev = preview.data.html.match(/href="https:\/\/mail\.example\.org\/unsubscribe\?token=([^"&]+)"/);
  assert.ok(mPrev, 'preview must contain signed unsubscribe URL');

  const sent = await post(server.base, '/api/test', {
    csv: CSV, html: 'templates/bcci-connect-v2.html', subject: 'Hi', to: 'one@example.com',
  }, { cookie });
  assert.equal(sent.data.ok, true, JSON.stringify(sent.data));
  const raw = sink.messages[0].data.replace(/\r\n[ \t]+/g, ' ');
  assert.match(raw, /^List-Unsubscribe: <https:\/\/mail\.example\.org\/unsubscribe\?token=[^>]+>, <mailto:/m);
  assert.match(raw, /^List-Unsubscribe-Post: List-Unsubscribe=One-Click$/m);

  const tokenMatch = raw.match(/https:\/\/mail\.example\.org\/unsubscribe\?token=([^>\s]+)/);
  assert.ok(tokenMatch);
  const token = decodeURIComponent(tokenMatch[1]);

  // GET /unsubscribe without login renders a confirmation form with no side effect (scanner-safe).
  const page = await get(server.base, `/unsubscribe?token=${encodeURIComponent(token)}`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /^text\/html/);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.match(page.data, /<form\b[^>]*method="POST"/i);
  assert.match(page.data, /one@example\.com/);
  assert.equal((await get(server.base, '/api/suppression', { cookie })).data.count, 0);

  // Tampered or missing token is rejected on both GET and POST without modifying suppressions.
  assert.equal((await get(server.base, '/unsubscribe?token=bad.token')).status, 400);
  const badPost = await fetch(`${server.base}/unsubscribe?token=bad.token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'List-Unsubscribe=One-Click',
  });
  assert.equal(badPost.status, 400);
  assert.equal((await get(server.base, '/api/suppression', { cookie })).data.count, 0);

  // Cross-site forged POST is rejected even with a valid token.
  const csrfPost = await fetch(`${server.base}/unsubscribe?token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
    body: 'List-Unsubscribe=One-Click',
  });
  assert.equal(csrfPost.status, 403);
  assert.equal((await get(server.base, '/api/suppression', { cookie })).data.count, 0);

  // RFC 8058 one-click POST without login adds the recipient to suppressed.csv.
  const oneClick = await fetch(`${server.base}/unsubscribe?token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'List-Unsubscribe=One-Click',
  });
  assert.equal(oneClick.status, 200);
  assert.match(readFileSync(join(dir, 'suppressed.csv'), 'utf8'), /^one@example\.com,unsubscribe,/m);

  // Form POST via token in body works across a server restart (secret persisted).
  await server.stop({ keepData: true });
  const restarted = await startServer({ dir, env });
  t.after(() => restarted.stop());

  const rawHttp = (port, { method = 'GET', path, headers = {}, body = null }) => new Promise((done, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      res.resume();
      res.on('end', () => done({ status: res.statusCode, headers: res.headers }));
    });
    req.on('error', reject);
    req.end(body);
  });

  const tokPreview = decodeURIComponent(mPrev[1]);
  const formBody = new URLSearchParams({ token: tokPreview }).toString();
  const formRes = await rawHttp(restarted.port, {
    method: 'POST',
    path: '/unsubscribe',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'content-length': Buffer.byteLength(formBody),
      host: 'mail.example.org',
      origin: 'https://mail.example.org',
    },
    body: formBody,
  });
  assert.equal(formRes.status, 200);
  assert.match(readFileSync(join(dir, 'suppressed.csv'), 'utf8'), /^director@example\.com,unsubscribe,/m);
  // Reverse-proxy Host header for /unsubscribe still keeps /api/* restricted.
  assert.equal((await rawHttp(restarted.port, { path: '/api/state', headers: { host: 'mail.example.org' } })).status, 403);
});

test('signed /unsubscribe works when MAILROOM_PUBLIC_URL includes a subpath', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mailroom-unsub-subpath-'));
  const sink = await startSmtpSink();
  const env = { ...smtpEnv(sink), MAILROOM_PUBLIC_URL: 'https://mail.example.org/mailroom', MAILROOM_PASSWORD: 'secret-pass' };
  const server = await startServer({ dir, env });
  t.after(async () => { await sink.close(); await server.stop(); rmSync(dir, { recursive: true, force: true }); });

  const login = await post(server.base, '/api/login', { password: 'secret-pass' });
  const cookie = login.headers.get('set-cookie').split(';')[0];

  const preview = await post(server.base, '/api/preview', {
    csv: CSV, html: 'templates/bcci-connect-v2.html', subject: 'Hi',
  }, { cookie });
  const m = preview.data.html.match(/href="https:\/\/mail\.example\.org\/mailroom\/unsubscribe\?token=([^"&]+)"/);
  assert.ok(m, 'preview must include subpath unsubscribe URL');
  const token = decodeURIComponent(m[1]);

  const page = await get(server.base, `/mailroom/unsubscribe?token=${encodeURIComponent(token)}`);
  assert.equal(page.status, 200);
  assert.match(page.data, /<form\b[^>]*action="\/mailroom\/unsubscribe"/i);

  const subRes = await fetch(`${server.base}/mailroom/unsubscribe`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token }).toString(),
  });
  assert.equal(subRes.status, 200);
  assert.match(readFileSync(join(dir, 'suppressed.csv'), 'utf8'), /^director@example\.com,unsubscribe,/m);
});
