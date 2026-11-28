import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CSV, startServer, post, get, wait } from './helpers/server.mjs';
import { startSmtpSink } from './helpers/smtp-sink.mjs';
import {
  createRateLimiter,
  formatReportCsv,
  linkWarnings,
  rateLimitsFromEnv,
  recipientsToCsv,
  runCampaign,
} from '../src/lib/core.mjs';
import { createLoginLimiter, hashPassword, verifyPassword } from '../src/lib/auth.mjs';
import { loadConfig, parseEnv, saveConfig } from '../src/lib/config.mjs';
import { signUnsubscribeToken, verifyUnsubscribeToken } from '../src/lib/mailer.mjs';
import { inspectSenderDns } from '../src/lib/dns.mjs';

const TEMPLATE = 'templates/bcci-connect.html';
const dir = () => mkdtempSync(join(tmpdir(), 'mailroom-complete-'));

const smtpEnv = (sink, extra = {}) => ({
  SMTP_HOST: '127.0.0.1',
  SMTP_PORT: String(sink.port),
  EMAIL_FROM: 'Desk <desk@local.test>',
  ...extra,
});

async function until(check, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (check()) return;
    await wait(40);
  }
  throw new Error('timed out waiting for the condition');
}

test('inspectSenderDns checks MX, SPF, DMARC, and DKIM with lookup limits and advisories', async () => {
  const healthy = await inspectSenderDns('News <news@example.com>', {
    selector: 'mail',
    resolveMx: async (host) => (host === 'example.com' ? [{ exchange: 'mx.example.com', priority: 10 }] : []),
    resolveTxt: async (host) => {
      if (host === 'example.com') return [['v=spf1 include:_spf.example.net -all']];
      if (host === '_dmarc.example.com') return [['v=DMARC1; p=reject; rua=mailto:dmarc@example.com']];
      if (host === 'mail._domainkey.example.com') return [['v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA']];
      return [];
    },
  });
  assert.equal(healthy.domain, 'example.com');
  assert.equal(healthy.ok, true);
  assert.equal(healthy.checks.mx.ok, true);
  assert.equal(healthy.checks.spf.ok, true);
  assert.equal(healthy.checks.dmarc.ok, true);
  assert.equal(healthy.checks.dmarc.policy, 'reject');
  assert.equal(healthy.checks.dkim.ok, true);
  assert.equal(healthy.checks.dkim.selector, 'mail');

  const risky = await inspectSenderDns('broken.example', {
    resolveMx: async () => [],
    resolveTxt: async (host) => {
      if (host === 'broken.example') {
        const includes = Array.from({ length: 11 }, (_, i) => `include:s${i}.example`).join(' ');
        return [[`v=spf1 ${includes} +all`]];
      }
      if (host === '_dmarc.broken.example') return [['v=DMARC1; p=none']];
      return [];
    },
  });
  assert.equal(risky.ok, false);
  assert.equal(risky.checks.mx.ok, false);
  assert.equal(risky.checks.spf.ok, false);
  assert.match(risky.checks.spf.detail, /10 DNS lookup|\+all/i);
  assert.match(risky.warnings.join(' '), /p=none|quarantine|reject/i);
  assert.equal(risky.checks.dkim.ok, false);

  const revoked = await inspectSenderDns('news@example.com', {
    selector: 'default',
    resolveMx: async () => [{ exchange: '', priority: 0 }],
    resolveTxt: async (host) => {
      if (host === 'example.com') return [['v=spf1 -all']];
      if (host === '_dmarc.example.com') return [['v=DMARC1; p=reject']];
      if (host === 'default._domainkey.example.com') return [['v=DKIM1; p=']];
      return [];
    },
  });
  assert.equal(revoked.ok, false);
  assert.equal(revoked.checks.mx.ok, false);
  assert.match(revoked.checks.mx.detail, /Null MX/i);
  assert.equal(revoked.checks.dkim.ok, false);
  assert.equal(revoked.checks.dkim.status, 'fail');
  assert.match(revoked.checks.dkim.detail, /Revoked/i);
});

test('POST /api/settings/dns validates input and exposes DNS pre-flight checks', async (t) => {
  const server = await startServer();
  t.after(server.stop);

  const missing = await post(server.base, '/api/settings/dns', { from: 'not-an-address' });
  assert.equal(missing.status, 400);

  const checked = await post(server.base, '/api/settings/dns', { from: 'news@nonexistent.invalid', selector: 'bad!' });
  assert.equal(checked.status, 400);

  const validSyntax = await post(server.base, '/api/settings/dns', { from: 'news@localhost.invalid' });
  assert.equal(validSyntax.status, 200);
  assert.equal(validSyntax.data.domain, 'localhost.invalid');
  assert.ok('checks' in validSyntax.data && 'mx' in validSyntax.data.checks && 'spf' in validSyntax.data.checks);
});

test('MAX_PER_DAY parses, enforces a 24-hour rolling window across runs, and persists in Settings', async (t) => {
  assert.deepEqual(
    rateLimitsFromEnv({ MAX_PER_HOUR: '100', MAX_PER_DOMAIN_PER_HOUR: '20', MAX_PER_DAY: '250' }),
    { perHour: 100, perDomainPerHour: 20, perDay: 250 },
  );
  assert.throws(() => rateLimitsFromEnv({ MAX_PER_DAY: '-1' }), /MAX_PER_DAY/);
  assert.throws(() => rateLimitsFromEnv({ MAX_PER_DAY: 'fast' }), /MAX_PER_DAY/);

  let now = 1_700_000_000_000;
  const limiter = createRateLimiter({
    perHour: 100,
    perDay: 2,
    history: [
      { at: now - 23 * 3600_000, domain: 'a.example' },
      { at: now - 2 * 3600_000, domain: 'b.example' },
    ],
    now: () => now,
  });
  const blocked = limiter.check('c.example');
  assert.equal(blocked.scope, 'day');
  assert.ok(blocked.waitMs > 0 && blocked.waitMs <= 3600_000);
  now += blocked.waitMs + 1;
  assert.deepEqual(limiter.check('c.example'), { waitMs: 0, scope: null });

  const sink = await startSmtpSink();
  const server = await startServer({ env: smtpEnv(sink) });
  t.after(async () => { await server.stop(); await sink.close(); });

  const badDay = await post(server.base, '/api/settings', {
    host: '127.0.0.1', port: sink.port, from: 'desk@local.test', maxPerDay: 'bad', test: false,
  });
  assert.equal(badDay.status, 400);
  assert.match(badDay.data.error, /MAX_PER_DAY/);

  const saved = await post(server.base, '/api/settings', {
    host: '127.0.0.1',
    port: sink.port,
    from: 'desk@local.test',
    publicUrl: 'https://mail.example.com/sub/',
    maxPerHour: '200',
    maxPerDomainPerHour: '25',
    maxPerDay: '300',
    test: false,
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.smtp.publicUrl, 'https://mail.example.com/sub');
  assert.equal(saved.data.smtp.maxPerDomainPerHour, '25');
  assert.equal(saved.data.smtp.maxPerDay, '300');

  const got = await get(server.base, '/api/settings');
  assert.equal(got.data.publicUrl, 'https://mail.example.com/sub');
  assert.equal(got.data.maxPerDomainPerHour, '25');
  assert.equal(got.data.maxPerDay, '300');

  // Verify runCampaign respects perDay ceiling across log writes.
  const logDir = dir();
  t.after(() => rmSync(logDir, { recursive: true, force: true }));
  const logPath = join(logDir, 'sent.jsonl');
  const supPath = join(logDir, 'suppressed.csv');
  const events = [];
  const fakeMailer = {
    cfg: { host: '127.0.0.1', port: 25, secure: false, requireTLS: false, user: '', pass: '', from: 'desk@local.test', replyTo: '', unsubscribeUrl: '', isLocal: true, configured: true },
    getTransport() { throw new Error('unused'); },
    async verify() { return { ok: true }; },
    async send({ to }) { return { success: true, messageId: `<${to}@local.test>`, inline: 0 }; },
    close() {},
  };
  let stops = false;
  const run = await runCampaign({
    recipients: [
      { _email: 'one@example.com', _name: 'One', _company: '' },
      { _email: 'two@example.com', _name: 'Two', _company: '' },
    ],
    templateHtml: '<p>Hi <a href="mailto:desk@local.test?subject=unsubscribe">u</a></p>',
    subjectTemplate: 'Hi',
    assetsDir: null,
    campaignId: 'day-cap-test',
    suppressionPath: supPath,
    logPath,
    limits: { perHour: 500, perDomainPerHour: 0, perDay: 1 },
    delayMs: 0,
    mailer: fakeMailer,
    shouldStop: () => stops,
    onEvent: (ev) => {
      events.push(ev);
      if (ev.type === 'throttle' && ev.scope === 'day') stops = true;
    },
  });
  assert.equal(run.sent, 1);
  assert.equal(run.stopped, true);
  assert.ok(events.some((e) => e.type === 'throttle' && e.scope === 'day'));
});

test('config saveConfig/parseEnv round-trips quotes and backslashes cleanly', (t) => {
  const d = dir();
  t.after(() => rmSync(d, { recursive: true, force: true }));
  const cfgPath = join(d, 'config.env');
  const weirdPass = 'p@"ss\\word #1!';
  saveConfig({ SMTP_PASS: weirdPass, EMAIL_FROM: '"News \\Co" <news@example.com>' }, cfgPath);
  const parsed = parseEnv(readFileSync(cfgPath, 'utf8'));
  assert.equal(parsed.SMTP_PASS, weirdPass);
  assert.equal(parsed.EMAIL_FROM, '"News \\Co" <news@example.com>');
  const prev = { SMTP_PASS: process.env.SMTP_PASS, EMAIL_FROM: process.env.EMAIL_FROM };
  delete process.env.SMTP_PASS;
  delete process.env.EMAIL_FROM;
  try {
    const loaded = loadConfig(cfgPath);
    assert.equal(loaded.values.SMTP_PASS, weirdPass);
    assert.equal(process.env.SMTP_PASS, weirdPass);
  } finally {
    if (prev.SMTP_PASS === undefined) delete process.env.SMTP_PASS;
    else process.env.SMTP_PASS = prev.SMTP_PASS;
    if (prev.EMAIL_FROM === undefined) delete process.env.EMAIL_FROM;
    else process.env.EMAIL_FROM = prev.EMAIL_FROM;
  }
});

test('CSV exports and raw CSV saves neutralise whitespace-prefixed formulas and flag javascript links', async (t) => {
  const csv = recipientsToCsv([{ _email: 'user@example.com', _name: ' =CMD()', _company: '\t+1+1' }]);
  assert.match(csv, /' =CMD\(\)/);
  assert.match(csv, /user@example\.com,' =CMD\(\),'\t\+1\+1/);
  const report = formatReportCsv([{ val: '  @SUM(A1:A2)' }], [{ key: 'val', label: 'val' }]);
  assert.match(report, /^val\n' {2}@SUM\(A1:A2\)\n$/);

  const warnings = linkWarnings('<a href="javascript:alert(1)">bad</a><a href="https://example.com/unsub">unsubscribe</a>');
  assert.ok(warnings.some((w) => w.code === 'unsafe-link'));

  const server = await startServer();
  t.after(server.stop);
  const saved = await post(server.base, '/api/recipients', {
    text: 'email,name,note\nalice@example.com,Alice,"=1+1"\nbob@example.com," +SUM(1)","@evil"',
    format: 'csv',
    name: `formula-guard-${process.pid}`,
  });
  assert.equal(saved.status, 201);
  t.after(() => rmSync(join(process.cwd(), saved.data.path), { force: true }));
  const disk = readFileSync(join(process.cwd(), saved.data.path), 'utf8');
  assert.match(disk, /'=1\+1/);
  assert.match(disk, /'\+SUM\(1\)/);
  assert.match(disk, /'@evil/);
});

test('unsubscribe tokens verify against previous secrets during key rotation', async (t) => {
  const oldSecret = 'old-secret-0123456789abcdef0123456789abcdef';
  const newSecret = 'new-secret-fedcba9876543210fedcba9876543210';
  const oldToken = signUnsubscribeToken('reader@example.com', oldSecret);
  assert.equal(verifyUnsubscribeToken(oldToken, newSecret), null);
  assert.deepEqual(verifyUnsubscribeToken(oldToken, newSecret, [oldSecret]), { email: 'reader@example.com' });

  const server = await startServer({
    env: {
      MAILROOM_PUBLIC_URL: 'https://mail.example.com',
      MAILROOM_UNSUBSCRIBE_SECRET: newSecret,
      MAILROOM_UNSUBSCRIBE_PREVIOUS_SECRET: oldSecret,
    },
  });
  t.after(server.stop);
  const page = await get(server.base, `/unsubscribe?token=${encodeURIComponent(oldToken)}`, { host: 'mail.example.com' });
  assert.equal(page.status, 200);
  const res = await fetch(`${server.base}/unsubscribe?token=${encodeURIComponent(oldToken)}`, {
    method: 'POST',
    headers: { host: 'mail.example.com', origin: 'https://mail.example.com' },
  });
  assert.equal(res.status, 200);
  const list = await get(server.base, '/api/suppression');
  assert.ok(list.data.emails.includes('reader@example.com'));
});

test('login limiter bounds tracked IPs, verifyPassword bounds concurrency, and /api/ready reports readiness', async (t) => {
  const limiter = createLoginLimiter({ windowMs: 60_000, maxAttempts: 2, maxTrackedIps: 3 });
  limiter.note('10.0.0.1', false);
  limiter.note('10.0.0.2', false);
  limiter.note('10.0.0.3', false);
  limiter.note('10.0.0.4', false);
  assert.equal(limiter.trackedCount(), 3);

  const hash = await hashPassword('very-secret-passphrase');
  const checks = await Promise.all([
    verifyPassword('very-secret-passphrase', hash),
    verifyPassword('wrong-pass', hash),
    verifyPassword('very-secret-passphrase', hash),
    verifyPassword('wrong-pass-2', hash),
  ]);
  assert.deepEqual(checks, [true, false, true, false]);

  const server = await startServer({ env: { MAILROOM_PASSWORD: 'gate-password' } });
  t.after(server.stop);
  const ready = await get(server.base, '/api/ready');
  assert.equal(ready.status, 200);
  assert.equal(ready.data.ok, true);
  assert.equal(ready.data.ready, true);
  assert.deepEqual(Object.keys(ready.data.checks).sort(), ['logs', 'scheduler', 'storage', 'templates']);
});

test('POST /api/webhooks/bounces enforces webhook auth and ingests bounces and complaints', async (t) => {
  const secret = 'webhook-secret-123456789';
  const server = await startServer({
    env: {
      MAILROOM_PASSWORD: 'admin-password',
      MAILROOM_WEBHOOK_SECRET: secret,
    },
  });
  t.after(server.stop);

  // Unauthenticated and invalid signatures must fail closed (401).
  assert.equal((await post(server.base, '/api/webhooks/bounces', { type: 'hard-bounce', email: 'a@example.com' })).status, 401);
  assert.equal((await post(server.base, '/api/webhooks/bounces', { type: 'hard-bounce', email: 'a@example.com' }, {
    authorization: 'Bearer wrong-secret',
  })).status, 401);

  const res1 = await post(server.base, '/api/webhooks/bounces', {
    events: [
      { type: 'hard-bounce', email: 'hard@example.com' },
      { Type: 'SoftBounce', Email: 'soft@example.com' },
      { Type: 'SpamComplaint', Email: 'spam@example.com' },
      { type: 'email.bounced', data: { to: ['resend@example.com'] } },
      { notificationType: 'Bounce', bounce: { bounceType: 'Permanent', bouncedRecipients: [{ emailAddress: 'ses@example.com' }] } },
    ],
  }, { authorization: `Bearer ${secret}` });
  assert.equal(res1.status, 200);
  assert.deepEqual(res1.data.added.sort(), ['hard@example.com', 'resend@example.com', 'ses@example.com', 'spam@example.com']);
  assert.equal(res1.data.ignoredSoft, 1);

  // HMAC SHA-256 signature verification header.
  const payload = JSON.stringify({ notificationType: 'Complaint', complaint: { complainedRecipients: [{ emailAddress: 'hmac@example.com' }] } });
  const sig = 'sha256=' + createHmac('sha256', secret).update(payload).digest('hex');
  const res2 = await fetch(`${server.base}/api/webhooks/bounces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-mailroom-signature': sig, 'sec-fetch-site': 'cross-site' },
    body: payload,
  });
  assert.equal(res2.status, 200);
  const body2 = await res2.json();
  assert.deepEqual(body2.added, ['hmac@example.com']);

  const login = await post(server.base, '/api/login', { password: 'admin-password' });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie')?.split(';', 1)[0];
  assert.ok(cookie);
  const fromAdmin = await post(server.base, '/api/webhooks/bounces', {
    type: 'complaint', email: 'admin-entry@example.test',
  }, { cookie });
  assert.equal(fromAdmin.status, 200);
  assert.deepEqual(fromAdmin.data.added, ['admin-entry@example.test']);
});

test('campaigns, suppression, roster pagination, compose preview meta, and selected-index test send work at scale', async (t) => {
  const sink = await startSmtpSink();
  const server = await startServer({ env: smtpEnv(sink) });
  t.after(async () => { await server.stop(); await sink.close(); });

  // Build 1050 recipients so rows > 1000 are reachable via pagination.
  const rows = ['email,name,plan'];
  for (let i = 0; i < 1050; i++) {
    rows.push(`user${String(i).padStart(4, '0')}@example.com,User ${i},${i % 2 ? 'pro' : 'free'}`);
  }
  const saved = await post(server.base, '/api/recipients', {
    text: rows.join('\n'),
    format: 'csv',
    name: `big-roster-${process.pid}`,
  });
  assert.equal(saved.status, 201);
  t.after(() => rmSync(join(process.cwd(), saved.data.path), { force: true }));

  await post(server.base, '/api/suppress', { emails: ['user1045@example.com', 'extra1@example.com'], reason: 'hard-bounce' });
  await post(server.base, '/api/suppress', { emails: ['unsub@example.com'], reason: 'unsubscribe' });

  const page2 = await post(server.base, '/api/roster', { csv: saved.data.path, offset: 1000, pageSize: 100 });
  assert.equal(page2.status, 200);
  assert.equal(page2.data.total, 1050);
  assert.equal(page2.data.recipients.length, 50);
  const row1045 = page2.data.recipients.find((r) => r.email === 'user1045@example.com');
  assert.equal(row1045.suppressed, true);
  assert.equal(row1045.fields.plan, 'pro');

  const searchRoster = await post(server.base, '/api/roster', { csv: saved.data.path, q: 'user1045' });
  assert.equal(searchRoster.data.filtered, 1);
  assert.equal(searchRoster.data.recipients[0].email, 'user1045@example.com');

  const filteredSup = await get(server.base, '/api/suppression?q=1045&reason=hard-bounce&limit=10&offset=0');
  assert.equal(filteredSup.status, 200);
  assert.equal(filteredSup.data.count, 3);
  assert.equal(filteredSup.data.filtered, 1);
  assert.equal(filteredSup.data.entries[0].email, 'user1045@example.com');

  const preview = await post(server.base, '/api/preview', { csv: CSV, html: TEMPLATE, subject: 'Plan {{name}}', index: 1 });
  assert.equal(preview.status, 200);
  assert.equal(typeof preview.data.text, 'string');
  assert.ok(preview.data.bytes > 0);
  assert.equal(preview.data.to, 'one@example.com');

  // Selected recipient index is rendered when sending a test email.
  const testRes = await post(server.base, '/api/test', {
    csv: CSV, html: TEMPLATE, subject: 'Hi {{name}}', to: 'qa@example.com', index: 2,
  });
  assert.equal(testRes.status, 200);
  assert.equal(testRes.data.ok, true);
  await until(() => sink.messages.length >= 1);
  assert.match(sink.messages[0].data, /Subject: Hi Two/);

  // Campaign pagination & search.
  const sendA = await post(server.base, '/api/send', { raw: 'a@example.com, A', html: TEMPLATE, subject: 'A', campaign: 'alpha-nov', delay: 0, confirm: true });
  assert.equal(sendA.status, 202);
  await until(() => sink.messages.length >= 2);
  await wait(200);
  const sendB = await post(server.base, '/api/send', { raw: 'b@example.com, B', html: TEMPLATE, subject: 'B', campaign: 'beta-dec', delay: 0, confirm: true });
  assert.equal(sendB.status, 202);
  await until(() => sink.messages.length >= 3);
  await wait(200);

  const filteredCamp = await get(server.base, '/api/campaigns?q=beta&limit=1&offset=0');
  assert.equal(filteredCamp.status, 200);
  assert.equal(filteredCamp.data.total, 2);
  assert.equal(filteredCamp.data.filtered, 1);
  assert.equal(filteredCamp.data.campaigns[0].id, 'beta-dec');
});

test('the Compose HTTP configuration starts a protected, ready server', async (t) => {
  const compose = readFileSync(join(process.cwd(), 'compose.yml'), 'utf8');
  assert.match(compose, /127\.0\.0\.1:\$\{GUI_PORT/);
  const env = Object.fromEntries(
    [...compose.matchAll(/^ {6}(GUI_HOST|MAILROOM_PASSWORD|MAILROOM_ALLOW_INSECURE): "([^"]*)"$/gm)]
      .map(([, key, value]) => [key, value]),
  );
  assert.equal(env.GUI_HOST, '0.0.0.0');
  assert.match(env.MAILROOM_PASSWORD, /^\$\{MAILROOM_PASSWORD:/);
  env.MAILROOM_PASSWORD = 'synthetic-compose-password';
  const server = await startServer({ env });
  t.after(server.stop);
  assert.equal((await get(server.base, '/api/ready')).status, 200);
  assert.equal((await get(server.base, '/api/state')).status, 401);
});

test('compose.yml and UI expose readiness, webhook, DNS, preview, and paging controls', () => {
  const compose = readFileSync(join(process.cwd(), 'compose.yml'), 'utf8');
  assert.match(compose, /build:\s*\./);
  assert.match(compose, /\/api\/ready/);
  assert.match(compose, /MAILROOM_WEBHOOK_SECRET/);
  assert.match(compose, /MAX_PER_DAY/);
  assert.match(compose, /no-new-privileges:true/);

  const html = readFileSync(join(process.cwd(), 'public', 'index.html'), 'utf8');
  for (const id of [
    'previewMobileBtn',
    'previewDarkBtn',
    'previewTextBtn',
    'previewText',
    'proofWeight',
    'campaignSearch',
    'campaignsPager',
    'rosterSearch',
    'rosterPager',
    'suppressReasonFilter',
    'suppressPager',
    'setPublicUrl',
    'setMaxPerDomainPerHour',
    'setMaxPerDay',
    'dnsSelector',
    'dnsCheckBtn',
    'dnsList',
    'aboutReady',
    'aboutWebhook',
  ]) {
    assert.ok(html.includes(`id="${id}"`), `Missing #${id} in public/index.html`);
  }
});
