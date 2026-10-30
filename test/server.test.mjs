import test from 'node:test';
import assert from 'node:assert/strict';
import { statSync, readFileSync, existsSync, rmSync, mkdtempSync, writeFileSync, symlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { CSV, startServer, post, get, wait } from './helpers/server.mjs';
import { startSmtpSink } from './helpers/smtp-sink.mjs';

const TEMPLATE = 'templates/bcci-connect.html';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('a fresh install reports itself unconfigured', async (t) => {
  const server = await startServer();
  t.after(server.stop);

  const state = await get(server.base, '/api/state');
  assert.equal(state.status, 200);
  assert.equal(state.data.app.name, 'Mailroom');
  assert.equal(state.data.setup.configured, false);
  assert.equal(state.data.setup.authRequired, false);
  assert.ok(Array.isArray(state.data.csvs));

  assert.equal((await get(server.base, '/')).status, 200);
  assert.equal((await get(server.base, '/favicon.svg')).status, 200);
});

test('the API refuses path traversal and malformed input', async (t) => {
  const server = await startServer();
  t.after(server.stop);

  const traversal = await post(server.base, '/api/preview', {
    csv: '../../etc/passwd', html: TEMPLATE, subject: 'x',
  });
  assert.equal(traversal.status, 400);

  const missing = await post(server.base, '/api/preview', {
    csv: 'data/nope.csv', html: TEMPLATE, subject: 'x',
  });
  assert.equal(missing.status, 400);

  const longSubject = await post(server.base, '/api/preview', {
    csv: CSV, html: TEMPLATE, subject: 'x'.repeat(301),
  });
  assert.equal(longSubject.status, 400);
});

test('a symlink inside data/ cannot read a file outside it', async (t) => {
  const server = await startServer();
  const dir = mkdtempSync(join(tmpdir(), 'mailroom-link-'));
  const secret = join(dir, 'secret.csv');
  writeFileSync(secret, 'email\noutside@example.com\n');
  const name = `symlink-test-${process.pid}.csv`;
  symlinkSync(secret, join(ROOT, 'data', name));
  t.after(async () => {
    rmSync(join(ROOT, 'data', name), { force: true });
    rmSync(dir, { recursive: true, force: true });
    await server.stop();
  });

  const response = await post(server.base, '/api/preview', {
    csv: `data/${name}`, html: TEMPLATE, subject: 'x',
  });
  assert.equal(response.status, 400);
  assert.match(response.data.error, /Not allowed/);
});

test('setup saves SMTP settings, then preview, roster and send work', async (t) => {
  const sink = await startSmtpSink();
  const server = await startServer();
  t.after(async () => { await server.stop(); await sink.close(); });
  const base = server.base;

  // A bad host must not be saved.
  const failed = await post(base, '/api/settings', {
    host: '127.0.0.1', port: 1, user: 'desk@local.test', pass: 'x', from: 'Desk <desk@local.test>',
  });
  assert.equal(failed.status, 200);
  assert.equal(failed.data.ok, false);
  assert.equal(existsSync(join(server.workDir, 'config.env')), false);

  // The real sink is accepted.
  const saved = await post(base, '/api/settings', {
    host: '127.0.0.1', port: sink.port, user: 'desk@local.test', pass: 'app-password',
    from: 'Desk <desk@local.test>',
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.ok, true);
  assert.equal(saved.data.verified, true);

  const configPath = join(server.workDir, 'config.env');
  assert.equal(statSync(configPath).mode & 0o777, 0o600);
  const savedText = readFileSync(configPath, 'utf8');
  assert.match(savedText, new RegExp(`SMTP_PORT=${sink.port}`));
  assert.match(savedText, /EMAIL_FROM="Desk <desk@local.test>"/);

  const state = await get(base, '/api/state');
  assert.equal(state.data.setup.configured, true);
  assert.equal(state.data.smtp.passwordSet, true);

  const preview = await post(base, '/api/preview', { csv: CSV, html: TEMPLATE, subject: 'Hi {{name}}' });
  assert.equal(preview.status, 200);
  assert.equal(preview.data.total, 4);
  assert.equal(preview.data.inline, 3);
  assert.match(preview.data.html, /data:image\//);

  const roster = await post(base, '/api/roster', { csv: CSV });
  assert.equal(roster.status, 200);
  assert.equal(roster.data.recipients.length, 4);
  assert.ok(roster.data.recipients.every((r) => typeof r.sent === 'boolean'));

  const unconfirmed = await post(base, '/api/send', { csv: CSV, html: TEMPLATE, subject: 'x' });
  assert.equal(unconfirmed.status, 400);

  const started = await post(base, '/api/send', {
    csv: CSV, html: TEMPLATE, subject: 'Hi {{name}}', campaign: 'api-test', delay: 0, confirm: true,
  });
  assert.equal(started.status, 202);
  assert.ok(started.data.jobId);

  // A second run while the first is in flight is refused.
  const concurrent = await post(base, '/api/send', {
    csv: CSV, html: TEMPLATE, subject: 'again', delay: 0, confirm: true,
  });
  assert.equal(concurrent.status, 409);

  await wait(1500);
  const log = readFileSync(join(server.workDir, 'sent.jsonl'), 'utf8').trim().split('\n').filter(Boolean);
  assert.equal(log.length, 4);
  assert.ok(log.every((line) => JSON.parse(line).campaign === 'api-test'));
  assert.equal(sink.messages.length, 4);
  assert.match(sink.messages[0].data, /Subject: Hi /);
  assert.match(sink.messages[0].data, /multipart\/related/);

  const idle = await get(base, '/api/jobs/active');
  assert.equal(idle.data.jobId, null);
});

test('pasted recipients can be saved as a CSV and mailed', async (t) => {
  const sink = await startSmtpSink();
  const server = await startServer();
  const written = [];
  t.after(async () => {
    for (const path of written) rmSync(join(ROOT, path), { force: true });
    await server.stop();
    await sink.close();
  });
  const base = server.base;

  await post(base, '/api/settings', {
    host: '127.0.0.1', port: sink.port, user: 'desk@local.test', pass: 'x', from: 'Desk <desk@local.test>',
  });

  const saved = await post(base, '/api/recipients', {
    text: 'one@example.com, One\nTwo <two@example.com>\nbad',
    name: 'pasted-test',
  });
  assert.equal(saved.status, 201);
  assert.equal(saved.data.recipients, 2);
  written.push(saved.data.path);

  const parsed = await post(base, '/api/preview', {
    csv: saved.data.path, html: TEMPLATE, subject: 'Hello {{name}}',
  });
  assert.equal(parsed.status, 200);
  assert.equal(parsed.data.total, 2);

  const empty = await post(base, '/api/recipients', { text: '  ' });
  assert.equal(empty.status, 400);
});

test('an unexpected Host header is rejected', async (t) => {
  const server = await startServer();
  t.after(server.stop);

  const status = await new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: server.port, path: '/api/state', method: 'GET',
      headers: { Host: 'evil.example.com' },
    }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.end();
  });

  assert.equal(status, 403);
  assert.equal((await get(server.base, '/api/state')).status, 200);
});

test('a cross-origin page cannot drive a send', async (t) => {
  const server = await startServer();
  t.after(server.stop);

  // A page on another site posting JSON here would spend the stored SMTP
  // credentials, so any foreign Origin is refused before routing.
  const payload = { csv: CSV, html: TEMPLATE, subject: 'x', campaign: 'csrf', confirm: true, delay: 0 };
  assert.equal((await post(server.base, '/api/send', payload, { origin: 'https://evil.example.com' })).status, 403);
  assert.equal((await post(server.base, '/api/send', payload, { origin: 'null' })).status, 403);

  // The app's own page must keep working: browsers attach its Origin too.
  const preview = await post(server.base, '/api/preview', { csv: CSV, html: TEMPLATE, subject: 'x' }, { origin: server.base });
  assert.equal(preview.status, 200);
});

test('a subject line reaches the recipient unescaped', async (t) => {
  const sink = await startSmtpSink();
  const server = await startServer();
  t.after(async () => { await server.stop(); await sink.close(); });
  const base = server.base;

  await post(base, '/api/settings', {
    host: '127.0.0.1', port: sink.port, user: 'desk@local.test', pass: 'x', from: 'Desk <desk@local.test>',
  });

  const subject = 'Save 20% & more for {{name}}';
  const preview = await post(base, '/api/preview', { csv: CSV, html: TEMPLATE, subject });
  assert.equal(preview.data.subject, 'Save 20% & more for Director');

  const started = await post(base, '/api/send', { csv: CSV, html: TEMPLATE, subject, campaign: 'subject-test', delay: 0, confirm: true });
  assert.equal(started.status, 202);
  await wait(1500);

  assert.equal(sink.messages.length, 4);
  // Headers only: the HTML body is supposed to contain entities.
  const headers = sink.messages[0].data.split('\r\n\r\n')[0];
  assert.match(headers, /Subject: Save 20% & more for Director/);
  assert.doesNotMatch(headers, /&amp;|&#39;/);
});

test('MAILROOM_PASSWORD gates the whole app', async (t) => {
  const server = await startServer({ env: { MAILROOM_PASSWORD: 'secret-pass' } });
  t.after(server.stop);
  const base = server.base;

  assert.equal((await get(base, '/api/state')).status, 401);
  // The container health check has to keep working behind the password gate,
  // so liveness stays open and returns nothing useful.
  const health = await get(base, '/api/health');
  assert.equal(health.status, 200);
  assert.deepEqual(Object.keys(health.data).sort(), ['ok', 'version']);
  const page = await get(base, '/');
  assert.equal(page.status, 302);
  assert.equal(page.headers.get('location'), '/login.html');
  assert.equal((await get(base, '/login.html')).status, 200);

  assert.equal((await post(base, '/api/login', { password: 'nope' })).status, 401);

  const login = await post(base, '/api/login', { password: 'secret-pass' });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie');
  assert.match(cookie, /mr_session=/);
  assert.match(cookie, /HttpOnly/);

  const session = cookie.split(';')[0];
  const state = await get(base, '/api/state', { cookie: session });
  assert.equal(state.status, 200);
  assert.equal(state.data.setup.authRequired, true);

  await post(base, '/api/logout', {}, { cookie: session });
  assert.equal((await get(base, '/api/state', { cookie: session })).status, 401);
});
