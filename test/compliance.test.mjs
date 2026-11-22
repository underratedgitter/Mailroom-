import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  htmlToText,
  createMailer,
  runCampaign,
  readLog,
  loadSuppressed,
  addSuppressed,
  isSuppressed,
  createRateLimiter,
  rateLimitsFromEnv,
} from '../src/lib/core.mjs';
import { resolveSmtpConfig, configIssue } from '../src/lib/mailer.mjs';
import { startSmtpSink } from './helpers/smtp-sink.mjs';

const workDir = () => mkdtempSync(join(tmpdir(), 'mailroom-compliance-'));
const recipient = (email) => ({ _email: email, _name: 'Name', _company: 'Co' });
const unfold = (raw) => raw.replace(/\r\n[ \t]+/g, ' ');
const headersOf = (message) => unfold(message.data.split('\r\n\r\n')[0]);
const header = (message, name) => headersOf(message).match(new RegExp('^' + name + ': (.*)$', 'im'))?.[1];

const SMTP = { host: '127.0.0.1', secure: false, requireTLS: false, from: 'Desk <desk@news.example.org>' };

async function sendOne(extra = {}, html = '<p>Hello <b>Priya</b></p>') {
  const sink = await startSmtpSink();
  const mailer = createMailer({ ...SMTP, port: sink.port, ...extra });
  try {
    const result = await mailer.send({ to: 'priya@example.com', subject: 'Hi', html });
    assert.equal(result.success, true, result.error);
    return { message: sink.messages[0], result, sink };
  } finally {
    mailer.close();
    await sink.close();
  }
}

// ── Plain-text alternative ──────────────────────────────────────────
test('htmlToText turns markup into readable plain text', () => {
  const html = [
    '<html><head><title>T</title><style>p { color: red }</style></head><body>',
    '<!-- note --><p>Hello&nbsp;<b>Priya</b> &amp; team &#8211; &#x2764;</p>',
    '<p>Read <a href="https://example.com/post?a=1&amp;b=2">the post</a> or <a href="https://example.com">https://example.com</a></p>',
    '<ul><li>One</li><li>Two</li></ul>Line<br>break<script>alert(1)</script>',
    '<img src="cid:logo" alt="Company logo">',
    '</body></html>',
  ].join('');
  const text = htmlToText(html);

  assert.match(text, /^Hello Priya & team . /);
  assert.ok(text.includes('Read the post (https://example.com/post?a=1&b=2) or https://example.com'));
  assert.match(text, /- One\n- Two\n/);
  assert.match(text, /Line\nbreak/);
  assert.match(text, /Company logo/);
  assert.doesNotMatch(text, /color: red|alert|<|note|&amp;/);
  assert.doesNotMatch(text, /\n{3,}/);
});

test('htmlToText does not decode an escaped entity twice', () => {
  assert.equal(htmlToText('<p>&amp;lt;b&amp;gt;</p>'), '&lt;b&gt;');
  assert.equal(htmlToText('<p>&#1114112; &#xD800;</p>'), '&#1114112; &#xD800;');
});

test('a sent message carries both a plain-text and an HTML part', async () => {
  const { message } = await sendOne();
  assert.match(headersOf(message), /Content-Type: multipart\/alternative/i);
  assert.match(message.data, /Content-Type: text\/plain/i);
  assert.match(message.data, /Content-Type: text\/html/i);
  assert.match(message.data, /Hello Priya/);
});

// ── List-Unsubscribe ────────────────────────────────────────────────
test('every message has a mailto List-Unsubscribe on the From address', async () => {
  const { message } = await sendOne();
  assert.equal(header(message, 'List-Unsubscribe'), '<mailto:desk@news.example.org?subject=unsubscribe>');
  // RFC 8058 one-click needs an https target; without one the header is not valid.
  assert.equal(header(message, 'List-Unsubscribe-Post'), undefined);
});

test('the unsubscribe mailbox follows Reply-To, then an explicit override', async () => {
  const reply = await sendOne({ replyTo: 'Replies <replies@news.example.org>' });
  assert.equal(header(reply.message, 'List-Unsubscribe'), '<mailto:replies@news.example.org?subject=unsubscribe>');
  assert.match(headersOf(reply.message), /^Reply-To: .*replies@news.example.org/im);

  const explicit = await sendOne({ replyTo: 'replies@news.example.org', unsubscribeMailto: 'stop@news.example.org' });
  assert.equal(header(explicit.message, 'List-Unsubscribe'), '<mailto:stop@news.example.org?subject=unsubscribe>');
});

test('an https unsubscribe URL adds RFC 8058 one-click, with the recipient filled in', async () => {
  const { message } = await sendOne({ unsubscribeUrl: 'https://unsub.example.org/u?e={email}' });
  assert.equal(
    header(message, 'List-Unsubscribe'),
    '<https://unsub.example.org/u?e=priya%40example.com>, <mailto:desk@news.example.org?subject=unsubscribe>',
  );
  assert.equal(header(message, 'List-Unsubscribe-Post'), 'List-Unsubscribe=One-Click');
});

test('environment settings reach the config, and a bad unsubscribe URL is reported', () => {
  const cfg = resolveSmtpConfig({
    SMTP_HOST: 'h', SMTP_USER: 'u', SMTP_PASS: 'p', EMAIL_FROM: 'Desk <desk@news.example.org>',
    EMAIL_REPLY_TO: 'r@news.example.org', UNSUBSCRIBE_MAILTO: 'stop@news.example.org', UNSUBSCRIBE_URL: 'http://insecure.example.org/{email}',
  });
  assert.equal(cfg.replyTo, 'r@news.example.org');
  assert.equal(cfg.unsubscribeMailto, 'stop@news.example.org');
  assert.match(configIssue(cfg), /UNSUBSCRIBE_URL must be an https:\/\/ URL/);

  assert.equal(configIssue({ from: 'Desk <desk@news.example.org>', unsubscribeUrl: '' }), null);
  assert.match(configIssue({ from: 'desk', unsubscribeUrl: '' }), /EMAIL_FROM must be a full address/);
});

// ── Message-ID and Date ─────────────────────────────────────────────
test('each message gets a unique Message-ID on the sender domain and a valid Date', async () => {
  const sink = await startSmtpSink();
  const mailer = createMailer({ ...SMTP, port: sink.port });
  try {
    const before = Date.now();
    const a = await mailer.send({ to: 'a@example.com', subject: 's', html: 'x' });
    const b = await mailer.send({ to: 'b@example.com', subject: 's', html: 'x' });
    const ids = sink.messages.map((m) => header(m, 'Message-ID'));

    assert.notEqual(ids[0], ids[1]);
    for (const id of ids) assert.match(id, /^<[0-9a-f-]{36}@news\.example\.org>$/);
    assert.equal(a.messageId, ids[0]);
    assert.equal(b.messageId, ids[1]);

    const date = header(sink.messages[0], 'Date');
    assert.match(date, /^[A-Z][a-z]{2}, \d{1,2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} [+-]\d{4}$/);
    assert.ok(Math.abs(Date.parse(date) - before) < 60000);
  } finally {
    mailer.close();
    await sink.close();
  }
});

test('the sent log records the Message-ID so a bounce can be traced', async () => {
  const dir = workDir();
  const sink = await startSmtpSink();
  const mailer = createMailer({ ...SMTP, port: sink.port });
  try {
    await runCampaign({
      recipients: [recipient('a@example.com')],
      templateHtml: 'x', subjectTemplate: 'x', delayMs: 0, mailer,
      logPath: join(dir, 'sent.jsonl'), suppressionPath: join(dir, 'none.csv'),
    });
    assert.equal(readLog(join(dir, 'sent.jsonl'))[0].messageId, header(sink.messages[0], 'Message-ID'));
  } finally {
    mailer.close();
    await sink.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Suppression list ────────────────────────────────────────────────
test('addSuppressed normalises, de-duplicates and refuses junk', () => {
  const dir = workDir();
  const path = join(dir, 'nested', 'suppressed.csv');
  try {
    const first = addSuppressed(path, ['  Gone@Example.com ', 'gone@example.com', 'not-an-address', 'b@example.com'], 'unsubscribe');
    assert.deepEqual(first, { added: ['gone@example.com', 'b@example.com'], already: [], invalid: ['not-an-address'] });

    const again = addSuppressed(path, ['GONE@example.com', 'c@example.com']);
    assert.deepEqual([again.added, again.already], [['c@example.com'], ['gone@example.com']]);

    assert.deepEqual([...loadSuppressed(path)].sort(), ['b@example.com', 'c@example.com', 'gone@example.com']);
    assert.equal(isSuppressed(path, 'GONE@example.com'), true);
    assert.equal(isSuppressed(path, 'fine@example.com'), false);

    const lines = readFileSync(path, 'utf8').trim().split('\n');
    assert.equal(lines[0], 'email,reason,added');
    assert.match(lines[1], /^gone@example\.com,unsubscribe,\d{4}-\d\d-\d\dT/);
    assert.match(lines[3], /^c@example\.com,manual,/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing suppression file means nobody is suppressed; a hand-edited one still works', () => {
  const dir = workDir();
  try {
    assert.equal(loadSuppressed(join(dir, 'absent.csv')).size, 0);

    const path = join(dir, 'edited.csv');
    writeFileSync(path, '# exported from the old tool\nA@Example.com\n"b@example.com",bounce\r\nc@example.com;spam\nnonsense');
    assert.deepEqual([...loadSuppressed(path)].sort(), ['a@example.com', 'b@example.com', 'c@example.com']);

    // Appending to a file that lacks a trailing newline must not glue two rows together.
    addSuppressed(path, ['d@example.com']);
    assert.equal(isSuppressed(path, 'd@example.com'), true);
    assert.equal(isSuppressed(path, 'nonsense'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an address added to the list while a campaign runs is not mailed', async () => {
  const dir = workDir();
  const suppressionPath = join(dir, 'suppressed.csv');
  try {
    addSuppressed(suppressionPath, ['blocked@example.com']);
    const sent = [];
    const events = [];
    const summary = await runCampaign({
      recipients: [recipient('a@example.com'), recipient('Blocked@Example.com'), recipient('c@example.com'), recipient('d@example.com')],
      templateHtml: 'x', subjectTemplate: 'x', delayMs: 0, suppressionPath,
      mailer: {
        send: async ({ to }) => {
          sent.push(to);
          if (to === 'a@example.com') addSuppressed(suppressionPath, ['d@example.com'], 'unsubscribe');
          return { success: true };
        },
      },
      logPath: join(dir, 'sent.jsonl'),
      onEvent: (e) => events.push(e),
    });

    assert.deepEqual(sent, ['a@example.com', 'c@example.com']);
    assert.deepEqual([summary.sent, summary.skipped, summary.suppressed], [2, 2, 2]);
    const skips = events.filter((e) => e.status === 'skip');
    assert.deepEqual(skips.map((e) => [e.email, e.reason]), [['Blocked@Example.com', 'suppressed'], ['d@example.com', 'suppressed']]);

    const log = readLog(join(dir, 'sent.jsonl'));
    assert.deepEqual(log.filter((e) => e.reason === 'suppressed').map((e) => e.status), ['skipped', 'skipped']);
    // A suppressed address is not "sent", so it never counts as already mailed.
    assert.equal(log.filter((e) => e.status === 'sent').length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Rate ceiling ────────────────────────────────────────────────────
test('rateLimitsFromEnv defaults to a global hourly ceiling and rejects nonsense', () => {
  assert.deepEqual(rateLimitsFromEnv({}), { perHour: 500, perDomainPerHour: 0 });
  assert.deepEqual(rateLimitsFromEnv({ MAX_PER_HOUR: '120', MAX_PER_DOMAIN_PER_HOUR: '30' }), { perHour: 120, perDomainPerHour: 30 });
  assert.deepEqual(rateLimitsFromEnv({ MAX_PER_HOUR: '0' }), { perHour: 0, perDomainPerHour: 0 });
  for (const bad of ['abc', '-1', '1.5', ' ']) {
    assert.throws(() => rateLimitsFromEnv({ MAX_PER_HOUR: bad }), /MAX_PER_HOUR must be a whole number/);
    assert.throws(() => rateLimitsFromEnv({ MAX_PER_DOMAIN_PER_HOUR: bad }), /MAX_PER_DOMAIN_PER_HOUR must be a whole number/);
  }
});

test('the rate limiter holds a send until the oldest one in the hour ages out', () => {
  const HOUR = 3600000;
  let now = 1000000;
  const limiter = createRateLimiter({ perHour: 3, perDomainPerHour: 2, now: () => now });

  assert.equal(limiter.check('a.com').waitMs, 0);
  limiter.record('a.com');
  now += 1000; limiter.record('b.com');
  now += 1000;
  assert.deepEqual(limiter.check('b.com'), { waitMs: 0, scope: null });
  limiter.record('a.com');

  // Three sends in the last hour: the global ceiling holds until the first expires.
  assert.deepEqual(limiter.check('c.com'), { waitMs: HOUR - 2000, scope: 'hour' });
  // a.com has hit its own ceiling of 2.
  assert.equal(limiter.check('a.com').waitMs, HOUR - 2000);

  now += HOUR - 2000;
  assert.equal(limiter.check('c.com').waitMs, 0);
  assert.deepEqual(limiter.check('a.com'), { waitMs: 0, scope: null });
});

test('the limiter counts sends already in the log, and ignores older ones', () => {
  const now = Date.parse('2026-11-21T12:00:00Z');
  const history = [
    { at: new Date(now - 4000000).toISOString(), domain: 'a.com' },
    { at: new Date(now - 600000).toISOString(), domain: 'a.com' },
  ];
  const limiter = createRateLimiter({ perHour: 0, perDomainPerHour: 1, history, now: () => now });
  assert.deepEqual(limiter.check('a.com'), { waitMs: 3000000, scope: 'a.com' });
  assert.equal(limiter.check('b.com').waitMs, 0);
});

test('runCampaign pauses at the hourly ceiling instead of exceeding it', async () => {
  const dir = workDir();
  try {
    const sent = [];
    const events = [];
    let stop = false;
    const summary = await runCampaign({
      recipients: [recipient('a@x.com'), recipient('b@x.com'), recipient('c@x.com')],
      templateHtml: 'x', subjectTemplate: 'x', delayMs: 0,
      limits: { perHour: 2, perDomainPerHour: 0 },
      suppressionPath: join(dir, 'none.csv'),
      mailer: { send: async ({ to }) => { sent.push(to); return { success: true }; } },
      logPath: join(dir, 'sent.jsonl'),
      shouldStop: () => stop,
      onEvent: (e) => { events.push(e); if (e.type === 'throttle') stop = true; },
    });

    assert.deepEqual(sent, ['a@x.com', 'b@x.com']);
    assert.equal(summary.stopped, true);
    const throttle = events.find((e) => e.type === 'throttle');
    assert.equal(throttle.email, 'c@x.com');
    assert.equal(throttle.scope, 'hour');
    assert.ok(throttle.waitMs > 3500000 && throttle.waitMs <= 3600000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a fresh run counts mail sent by an earlier run in the same hour', async () => {
  const dir = workDir();
  const logPath = join(dir, 'sent.jsonl');
  try {
    const entry = (email, ago) => JSON.stringify({ email, status: 'sent', at: new Date(Date.now() - ago).toISOString(), campaign: 'earlier' });
    writeFileSync(logPath, [entry('old@x.com', 7200000), entry('x@y.com', 60000), entry('z@y.com', 30000)].join('\n') + '\n');

    const sent = [];
    let stop = false;
    await runCampaign({
      recipients: [recipient('a@x.com')],
      templateHtml: 'x', subjectTemplate: 'x', delayMs: 0, campaignId: 'later',
      limits: { perHour: 0, perDomainPerHour: 2 },
      suppressionPath: join(dir, 'none.csv'),
      mailer: { send: async ({ to }) => { sent.push(to); return { success: true }; } },
      logPath,
      shouldStop: () => stop,
      onEvent: (e) => { if (e.type === 'throttle') stop = true; },
    });
    // old@x.com is two hours old and no longer counts, so a@x.com goes out.
    assert.deepEqual(sent, ['a@x.com']);

    const blocked = [];
    stop = false;
    await runCampaign({
      recipients: [recipient('q@y.com')],
      templateHtml: 'x', subjectTemplate: 'x', delayMs: 0, campaignId: 'later',
      limits: { perHour: 0, perDomainPerHour: 2 },
      suppressionPath: join(dir, 'none.csv'),
      mailer: { send: async ({ to }) => { blocked.push(to); return { success: true }; } },
      logPath,
      shouldStop: () => stop,
      onEvent: (e) => { if (e.type === 'throttle') stop = true; },
    });
    assert.deepEqual(blocked, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
