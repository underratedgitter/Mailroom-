import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, renameSync, symlinkSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseCsv,
  parseRecipients,
  parseRecipientsText,
  recipientsToCsv,
  render,
  renderSubject,
  templateVariables,
  attachmentsFor,
  inlineForPreview,
  sentAddresses,
  campaignSummaries,
  readLog,
  appendLog,
  logArchives,
  runCampaign,
  emailRe,
  createMailer,
} from '../src/lib/core.mjs';
import { startSmtpSink } from './helpers/smtp-sink.mjs';

const workDir = () => mkdtempSync(join(tmpdir(), 'mailroom-core-'));

test('parseCsv handles quotes, CRLF, delimiters and BOM', () => {
  const rows = parseCsv('\uFEFFemail,name\r\n"a@b.co","Shah, Priya"\r\n');
  assert.deepEqual(rows, [{ email: 'a@b.co', name: 'Shah, Priya' }]);

  const semi = parseCsv('email;name\na@b.co;Priya\n');
  assert.deepEqual(semi, [{ email: 'a@b.co', name: 'Priya' }]);

  const tabs = parseCsv('email\tname\na@b.co\tPriya\n');
  assert.deepEqual(tabs, [{ email: 'a@b.co', name: 'Priya' }]);

  const multiline = parseCsv('email,note\na@b.co,"line one\nline two"\n');
  assert.equal(multiline[0].note, 'line one\nline two');
});

test('parseCsv rejects a file with no data rows', () => {
  assert.throws(() => parseCsv('email\n'), /no data rows/i);
});

test('parseRecipients: aliases, validation, de-duplication and limit', () => {
  const csv = [
    'E-Mail,Full Name,Organization',
    'a@b.co,Priya,Sunrise',
    'A@B.CO,Duplicate,Ignored',
    'not-an-email,Nope,None',
    'c@d.co,Raj,Patel',
  ].join('\n');

  const all = parseRecipients(csv);
  assert.equal(all.recipients.length, 2);
  assert.equal(all.duplicates, 1);
  assert.equal(all.invalid, 1);
  assert.equal(all.recipients[0]._name, 'Priya');
  assert.equal(all.recipients[0]._company, 'Sunrise');

  const limited = parseRecipients(csv, { limit: 1 });
  assert.equal(limited.recipients.length, 1);
  assert.equal(limited.truncated, 1);
});

test('parseRecipientsText accepts the forms the paste box documents', () => {
  const text = [
    '# a comment',
    'priya@example.com, Priya Shah, Sunrise Chemicals',
    'Raj Patel <raj@patel.in>',
    'ops@example.com\tOps Desk\tExample Co',
    'ops@example.com',
    'broken',
    '',
  ].join('\n');

  const parsed = parseRecipientsText(text);
  assert.equal(parsed.recipients.length, 3);
  assert.equal(parsed.duplicates, 1);
  assert.equal(parsed.invalid, 1);
  assert.deepEqual(
    parsed.recipients.map((r) => [r._email, r._name, r._company]),
    [
      ['priya@example.com', 'Priya Shah', 'Sunrise Chemicals'],
      ['raj@patel.in', 'Raj Patel', ''],
      ['ops@example.com', 'Ops Desk', 'Example Co'],
    ]
  );
});

test('recipientsToCsv round-trips through parseRecipients', () => {
  const original = [{ _email: 'a@b.co', _name: 'Shah, Priya', _company: 'Sun "Sunrise"' }];
  const parsed = parseRecipients(recipientsToCsv(original));
  assert.deepEqual(
    parsed.recipients.map((r) => [r._email, r._name, r._company]),
    [['a@b.co', 'Shah, Priya', 'Sun "Sunrise"']]
  );
});

test('render escapes values and understands the column aliases', () => {
  const rec = { _email: 'a@b.co', _name: '<Priya>', _company: 'A & B', city: 'Bharuch' };
  assert.equal(render('Hi {{name}} at {{company}} in {{city}}', rec), 'Hi &lt;Priya&gt; at A &amp; B in Bharuch');
  assert.equal(render('{{ email }}', rec), 'a@b.co');
  assert.equal(render('{{missing}}', rec), '');
  assert.equal(render('100% {{name}}', rec), '100% &lt;Priya&gt;');
});

test('placeholders never resolve to inherited Object.prototype members', () => {
  const rec = { _email: 'a@b.co', _name: 'Priya', _company: 'A', city: 'Bharuch' };
  for (const key of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
    assert.equal(render(`[{{${key}}}]`, rec), '[]', key);
    assert.equal(renderSubject(`[{{${key}}}]`, rec), '[]', key);
  }
  assert.equal(render('{{city}}', rec), 'Bharuch');
});

test('renderSubject keeps punctuation a header must not escape', () => {
  const rec = { _email: 'a@b.co', _name: "Priya O'Brien", _company: 'A & B' };
  assert.equal(
    renderSubject('20% off & more — {{name}} at {{company}}', rec),
    "20% off & more — Priya O'Brien at A & B",
  );
  assert.equal(renderSubject('Hi {{ name }}', rec), "Hi Priya O'Brien");
  assert.equal(renderSubject('{{missing}}!', rec), '!');

  // A line break in a header is an injection primitive, not content.
  assert.equal(renderSubject('Hi {{name}}\r\nBcc: evil@example.com', rec), "Hi Priya O'Brien Bcc: evil@example.com");
});

test('templateVariables lists merge fields once, in order', () => {
  assert.deepEqual(templateVariables('{{name}} {{company}} {{name}} {{city}}'), ['name', 'company', 'city']);
});

test('attachmentsFor and inlineForPreview resolve cid: references', () => {
  const dir = workDir();
  try {
    writeFileSync(join(dir, 'logo.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
    const html = '<img src="cid:logo"><img src="cid:missing">';

    const files = attachmentsFor(html, dir);
    assert.equal(files.length, 1);
    assert.equal(files[0].cid, 'logo');
    assert.equal(files[0].filename, 'logo.png');

    const preview = inlineForPreview(html, dir);
    assert.match(preview, /src="data:image\/png;base64,/);
    assert.match(preview, /cid:missing/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a symlink in the assets folder cannot attach or preview a file outside it', () => {
  const dir = workDir();
  try {
    const assets = join(dir, 'assets');
    mkdirSync(assets);
    writeFileSync(join(assets, 'logo.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
    writeFileSync(join(dir, 'secret.txt'), 'top secret');
    symlinkSync(join(dir, 'secret.txt'), join(assets, 'leak.png'));
    const html = '<img src="cid:logo"><img src="cid:leak">';

    assert.deepEqual(attachmentsFor(html, assets).map((a) => a.cid), ['logo']);
    const preview = inlineForPreview(html, assets);
    assert.match(preview, /cid:leak/);
    assert.ok(!preview.includes(Buffer.from('top secret').toString('base64')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('renaming an image is picked up without a restart', () => {
  const dir = workDir();
  try {
    writeFileSync(join(dir, 'logo.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
    assert.equal(attachmentsFor('<img src="cid:logo">', dir).length, 1);

    renameSync(join(dir, 'logo.png'), join(dir, 'BCCI-Connect-Logo.png'));
    assert.equal(attachmentsFor('<img src="cid:logo">', dir).length, 0);
    const renamed = attachmentsFor('<img src="cid:BCCI-Connect-Logo">', dir);
    assert.equal(renamed.length, 1);
    assert.equal(renamed[0].filename, 'BCCI-Connect-Logo.png');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sentAddresses scopes resume state to the campaign', () => {
  const entries = [
    { email: 'a@b.co', status: 'sent', campaign: 'one' },
    { email: 'b@c.co', status: 'sent', campaign: 'two' },
    { email: 'c@d.co', status: 'failed', campaign: 'one' },
  ];
  assert.deepEqual([...sentAddresses(entries, 'one')], ['a@b.co']);
  assert.deepEqual([...sentAddresses(entries, '')].sort(), ['a@b.co', 'b@c.co']);
});

test('campaignSummaries counts outcomes per campaign', () => {
  const summaries = campaignSummaries([
    { email: 'a@b.co', status: 'sent', campaign: 'x', at: '2026-01-01T00:00:00Z' },
    { email: 'b@c.co', status: 'skipped', campaign: 'x', at: '2026-01-01T00:00:01Z' },
    { email: 'c@d.co', status: 'failed', campaign: 'x', at: '2026-01-01T00:00:02Z' },
  ]);
  assert.deepEqual(summaries.map(({ id, sent, skipped, failed }) => ({ id, sent, skipped, failed })), [
    { id: 'x', sent: 1, skipped: 1, failed: 1 },
  ]);
});

test('the send log rotates by size and resume still sees every archive', () => {
  const dir = workDir();
  const logPath = join(dir, 'sent.jsonl');
  try {
    const limits = { maxBytes: 300, keep: 3 };
    for (let n = 1; n <= 30; n++) {
      appendLog(logPath, { email: `u${n}@b.co`, status: 'sent', at: 'x', campaign: 'big' }, limits);
    }

    const files = readdirSync(dir).sort();
    assert.deepEqual(files, ['sent.jsonl', 'sent.jsonl.1', 'sent.jsonl.2', 'sent.jsonl.3']);

    // Entries come back oldest first, and the newest ones are in the live file.
    const emails = readLog(logPath).map((e) => e.email);
    assert.equal(emails.at(-1), 'u30@b.co');
    assert.deepEqual(emails, [...emails].sort((a, b) => parseInt(a.slice(1), 10) - parseInt(b.slice(1), 10)));
    assert.ok(sentAddresses(readLog(logPath), 'big').has('u30@b.co'));
    assert.ok(readFileSync(logPath, 'utf8').length < 300 + 100);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('log rotation drops only archives beyond the retention count and is off at 0 bytes', () => {
  const dir = workDir();
  const logPath = join(dir, 'sent.jsonl');
  try {
    // A leftover from when more archives were kept, plus an unrelated file.
    for (const name of ['sent.jsonl.1', 'sent.jsonl.2', 'sent.jsonl.7', 'sent.jsonl.bak']) {
      writeFileSync(join(dir, name), '{"email":"old@b.co","status":"sent"}\n');
    }
    appendLog(logPath, { email: 'a@b.co', status: 'sent' }, { maxBytes: 1, keep: 2 });
    appendLog(logPath, { email: 'b@b.co', status: 'sent' }, { maxBytes: 1, keep: 2 });

    assert.deepEqual(logArchives(logPath).map((a) => a.n), [2, 1]);
    assert.ok(readdirSync(dir).includes('sent.jsonl.bak'));
    assert.ok(!readdirSync(dir).includes('sent.jsonl.7'));

    appendLog(logPath, { email: 'c@b.co', status: 'sent' }, { maxBytes: 0, keep: 2 });
    appendLog(logPath, { email: 'd@b.co', status: 'sent' }, { maxBytes: 0, keep: 2 });
    assert.equal(logArchives(logPath).length, 2, 'maxBytes 0 never rotates');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the rotation limits come from SEND_LOG_MAX_BYTES and SEND_LOG_KEEP', () => {
  const dir = workDir();
  const logPath = join(dir, 'sent.jsonl');
  const saved = { max: process.env.SEND_LOG_MAX_BYTES, keep: process.env.SEND_LOG_KEEP };
  try {
    process.env.SEND_LOG_MAX_BYTES = '100';
    process.env.SEND_LOG_KEEP = '1';
    for (let n = 0; n < 10; n++) appendLog(logPath, { email: `u${n}@b.co`, status: 'sent' });
    assert.deepEqual(readdirSync(dir).sort(), ['sent.jsonl', 'sent.jsonl.1']);
  } finally {
    for (const [key, value] of [['SEND_LOG_MAX_BYTES', saved.max], ['SEND_LOG_KEEP', saved.keep]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a send log that cannot be written stops the run with a plain message', async () => {
  const dir = workDir();
  try {
    let count = 0;
    await assert.rejects(runCampaign({
      recipients: [recipient('a@b.co'), recipient('b@c.co')],
      templateHtml: 'x',
      subjectTemplate: 'x',
      delayMs: 0,
      mailer: { send: async () => { count++; return { success: true }; } },
      logPath: join(dir, 'missing-folder', 'sent.jsonl'),
      onEvent: () => {},
    }), /Cannot write the send log .*sent\.jsonl/);
    assert.equal(count, 1, 'must not keep mailing people it cannot record');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runCampaign reports how many recipients were never attempted when stopped', async () => {
  const dir = workDir();
  try {
    let count = 0;
    const summary = await runCampaign({
      recipients: [1, 2, 3, 4].map((n) => recipient(`u${n}@b.co`)),
      templateHtml: 'x',
      subjectTemplate: 'x',
      delayMs: 0,
      mailer: { send: async () => { count++; return { success: true }; } },
      logPath: join(dir, 'stop.jsonl'),
      shouldStop: () => count >= 2,
      onEvent: () => {},
    });
    assert.equal(summary.stopped, true);
    assert.equal(summary.remaining, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const recipient = (email) => ({ _email: email, _name: 'Name', _company: 'Co' });

test('runCampaign sends, skips logged addresses and writes the log', async () => {
  const dir = workDir();
  const logPath = join(dir, 'sent.jsonl');
  try {
    const sent = [];
    const summary = await runCampaign({
      recipients: [recipient('a@b.co'), recipient('b@c.co'), recipient('c@d.co')],
      templateHtml: '<p>{{name}}</p>',
      subjectTemplate: 'Hi {{name}}',
      campaignId: 'test',
      alreadySent: new Set(['b@c.co']),
      delayMs: 0,
      mailer: { send: async ({ to }) => { sent.push(to); return { success: true, inline: 0 }; } },
      logPath,
      onEvent: () => {},
    });

    assert.deepEqual(sent, ['a@b.co', 'c@d.co']);
    assert.deepEqual([summary.sent, summary.skipped, summary.failed], [2, 1, 0]);

    const log = readLog(logPath);
    assert.equal(log.length, 3);
    assert.equal(log.filter((e) => e.status === 'sent').length, 2);
    assert.ok(log.every((e) => e.campaign === 'test'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runCampaign retries transient failures and stops on fatal ones', async () => {
  const dir = workDir();
  try {
    let attempts = 0;
    const retried = await runCampaign({
      recipients: [recipient('a@b.co')],
      templateHtml: 'x',
      subjectTemplate: 'x',
      delayMs: 0,
      retryDelay: 1,
      mailer: {
        send: async () => {
          attempts++;
          return attempts < 3 ? { success: false, error: 'ETIMEDOUT' } : { success: true };
        },
      },
      logPath: join(dir, 'retry.jsonl'),
      onEvent: () => {},
    });
    assert.equal(attempts, 3);
    assert.equal(retried.sent, 1);

    const fatal = await runCampaign({
      recipients: [recipient('a@b.co'), recipient('b@c.co')],
      templateHtml: 'x',
      subjectTemplate: 'x',
      delayMs: 0,
      mailer: { send: async () => ({ success: false, error: 'Daily user sending limit exceeded' }) },
      logPath: join(dir, 'fatal.jsonl'),
      onEvent: () => {},
    });
    assert.equal(fatal.stopped, true);
    assert.equal(fatal.failed, 1);
    assert.deepEqual(fatal.failures, [{ email: 'a@b.co', error: 'Daily user sending limit exceeded' }]);
    assert.equal(readLog(join(dir, 'fatal.jsonl')).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Runs one recipient against a mailer that always fails with `failure`; resolves the attempt count and summary. */
async function attemptsFor(failure) {
  let attempts = 0;
  const summary = await runCampaign({
    recipients: [recipient('a@b.co')],
    templateHtml: 'x',
    subjectTemplate: 'x',
    delayMs: 0,
    retryDelay: 1,
    mailer: { send: async () => { attempts++; return { success: false, ...failure }; } },
    onEvent: () => {},
  });
  return { attempts, summary };
}

test('a permanent rejection is not retried because the address echoed in it contains "rate" or "421"', async () => {
  const echoed = 'Recipient rate421@example.com rejected: no such user';
  assert.equal((await attemptsFor({ error: echoed, responseCode: 550 })).attempts, 1);
  assert.equal((await attemptsFor({ error: echoed, code: 'EENVELOPE' })).attempts, 1);
  // No structured code: the text heuristic still applies.
  assert.equal((await attemptsFor({ error: 'Too many connections, rate limited' })).attempts, 3);
});

test('a 4xx reply or a network error code is retried whatever the message says', async () => {
  assert.equal((await attemptsFor({ error: 'Mailbox busy', responseCode: 451 })).attempts, 3);
  assert.equal((await attemptsFor({ error: 'read failed', code: 'ECONNRESET' })).attempts, 3);
  assert.equal((await attemptsFor({ error: 'read failed', code: 'ETIMEDOUT' })).attempts, 3);
  assert.equal((await attemptsFor({ error: 'read failed', code: 'ESOCKET' })).attempts, 3);
});

test('EAUTH stops the run even when the message does not say "authentication"', async () => {
  const { attempts, summary } = await attemptsFor({ error: 'Invalid login: 535 credentials rejected', code: 'EAUTH' });
  assert.equal(attempts, 1);
  assert.equal(summary.stopped, true);
});

test('createMailer reports the SMTP reply code of a rejection', async () => {
  const sink = await startSmtpSink({ rcpt: (addr) => (addr.includes('rate421') ? '550 5.1.1 no such user' : null) });
  const mailer = createMailer({ host: '127.0.0.1', port: sink.port, secure: false, requireTLS: false, from: 'me@x.co' });
  try {
    const result = await mailer.send({ to: 'rate421@example.com', subject: 's', html: 'x' });
    assert.equal(result.success, false);
    assert.equal(result.responseCode, 550);
    assert.equal(result.code, 'EENVELOPE');
  } finally {
    mailer.close();
    await sink.close();
  }
});

test('runCampaign stops a run when the connection keeps failing', async () => {
  const dir = workDir();
  try {
    let attempts = 0;
    const events = [];
    const summary = await runCampaign({
      recipients: Array.from({ length: 60 }, (_, i) => recipient(`u${i}@b.co`)),
      templateHtml: 'x',
      subjectTemplate: 'x',
      delayMs: 0,
      retryDelay: 1,
      mailer: { send: async () => { attempts++; return { success: false, error: 'ESOCKET connection closed' }; } },
      logPath: join(dir, 'link.jsonl'),
      onEvent: (event) => events.push(event),
    });

    // 10 broken recipients x 3 attempts, not 60 x 3.
    assert.equal(attempts, 30);
    assert.equal(summary.stopped, true);
    assert.ok(summary.failed < 60);
    assert.ok(events.some((e) => e.type === 'fatal' && /failed 10 times in a row/.test(e.error)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runCampaign stops promptly during the gap between messages', async () => {
  const dir = workDir();
  try {
    let count = 0;
    const started = Date.now();
    const summary = await runCampaign({
      recipients: [1, 2, 3].map((n) => recipient(`u${n}@b.co`)),
      templateHtml: 'x',
      subjectTemplate: 'x',
      delayMs: 5000,
      mailer: { send: async () => { count++; return { success: true }; } },
      logPath: join(dir, 'cancel.jsonl'),
      shouldStop: () => count >= 1,
      onEvent: () => {},
    });

    assert.equal(count, 1);
    assert.equal(summary.stopped, true);
    assert.ok(Date.now() - started < 2000, 'should not sleep through the full gap');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('emailRe rejects obvious junk', () => {
  assert.equal(emailRe.test('a@b.co'), true);
  assert.equal(emailRe.test('a b@c.co'), false);
  assert.equal(emailRe.test('a@b'), false);
  assert.equal(emailRe.test('@b.co'), false);
});

test('an address the mailer would split or rewrite is invalid, not mailed to someone else', () => {
  // nodemailer reads "a,b@x.com" as two recipients and "a<b@x.com" as b@x.com,
  // so the address that was validated, de-duplicated and logged is not the
  // one that receives the message.
  for (const bad of ['a,b@x.com', 'a;b@x.com', 'a<b@x.com', 'a@x.com>', 'x@y.com,z.org', '"a"@x.com', 'a(b)@x.com']) {
    assert.equal(emailRe.test(bad), false, bad);
  }
  for (const good of ['first.last+tag@sub.example.co.uk', "o'brien@example.com", 'a_b-c@x.io']) {
    assert.equal(emailRe.test(good), true, good);
  }

  const parsed = parseRecipients('email,name\n"a,b@x.com",A\nok@x.com,Ok\n');
  assert.deepEqual(parsed.recipients.map((r) => r._email), ['ok@x.com']);
  assert.equal(parsed.invalid, 1);
});

/** Runs a campaign through a real mailer against a local SMTP sink; resolves what the run left behind. */
async function campaignAgainstSink({ sink: sinkOptions, addresses, run = {} }) {
  const sink = await startSmtpSink(sinkOptions);
  const mailer = createMailer({ host: '127.0.0.1', port: sink.port, secure: false, requireTLS: false, from: 'me@x.co', ...run.cfg });
  const dir = workDir();
  const logPath = join(dir, 'sent.jsonl');
  const suppressionPath = join(dir, 'suppressed.csv');
  try {
    const summary = await runCampaign({
      recipients: addresses.map(recipient),
      templateHtml: 'x',
      subjectTemplate: 'x',
      delayMs: 0,
      retryDelay: 1,
      limits: { perHour: 0, perDomainPerHour: 0 },
      mailer,
      logPath,
      suppressionPath,
      onEvent: () => {},
      ...run.options,
    });
    return {
      summary,
      messages: sink.messages,
      connections: sink.connectionCount(),
      open: sink.openCount(),
      log: readLog(logPath),
      suppressed: existsSync(suppressionPath) ? readFileSync(suppressionPath, 'utf8') : '',
    };
  } finally {
    mailer.close();
    await sink.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a refused recipient is judged on its own and never halts the campaign', async () => {
  // Each reply mentions words the old text match treated as account-level.
  const replies = [
    (addr) => `452 4.2.2 <${addr}> mailbox over quota`,
    (addr) => `550 5.2.1 <${addr}> account disabled`,
    (addr) => `550 5.7.1 <${addr}> authentication required`,
  ];
  for (const reply of replies) {
    const { summary, messages } = await campaignAgainstSink({
      sink: { rcpt: (addr) => (addr.includes('full') ? reply(addr) : null) },
      addresses: ['full@example.test', 'ok@example.test'],
    });
    assert.equal(summary.stopped, false, reply('x'));
    assert.deepEqual([summary.sent, summary.failed], [1, 1]);
    assert.equal(messages.length, 1);
  }
});

test('an address with "quota" or "disabled" in it does not stop the run when it is refused', async () => {
  const { summary } = await campaignAgainstSink({
    sink: { rcpt: (addr) => (addr.includes('quota') ? `550 5.1.1 <${addr}> no such user` : null) },
    addresses: ['quota-account-disabled@example.test', 'ok@example.test'],
  });
  assert.equal(summary.stopped, false);
  assert.equal(summary.sent, 1);
});

test('a sender-stage quota refusal still stops the run', async () => {
  const { summary, messages } = await campaignAgainstSink({
    sink: { mail: () => '550 5.4.5 Daily user sending quota exceeded' },
    addresses: ['a@example.test', 'b@example.test'],
  });
  assert.equal(summary.stopped, true);
  assert.equal(summary.failed, 1);
  assert.equal(messages.length, 0);
});

test('a timeout after the message was streamed is logged as uncertain, never retried, and skipped on resume', async () => {
  const dir = workDir();
  const logPath = join(dir, 'sent.jsonl');
  const sink = await startSmtpSink({ stall: (envelope) => envelope.to.some((to) => to.includes('hung')) });
  const mailer = createMailer({ host: '127.0.0.1', port: sink.port, secure: false, requireTLS: false, from: 'me@x.co', socketTimeout: 400 });
  const events = [];
  const options = {
    recipients: ['hung@example.test', 'ok@example.test'].map(recipient),
    templateHtml: 'x',
    subjectTemplate: 'x',
    campaignId: 'c1',
    delayMs: 0,
    retryDelay: 1,
    limits: { perHour: 0, perDomainPerHour: 0 },
    mailer,
    logPath,
    suppressionPath: join(dir, 'suppressed.csv'),
    onEvent: (event) => events.push(event),
  };
  try {
    const first = await runCampaign(options);
    // The server took the message of "hung" and never answered; sending it again would duplicate it.
    assert.equal(sink.messages.filter((m) => m.to.some((to) => to.includes('hung'))).length, 1);
    assert.equal(first.sent, 1);
    assert.equal(first.failed, 0);
    assert.deepEqual(first.uncertain.map((u) => u.email), ['hung@example.test']);
    assert.equal(first.remaining, 0);
    assert.ok(events.some((e) => e.type === 'progress' && e.status === 'uncertain' && e.email === 'hung@example.test'));
    assert.deepEqual(readLog(logPath).filter((e) => e.status === 'uncertain').map((e) => e.email), ['hung@example.test']);

    const again = await runCampaign({ ...options, alreadySent: sentAddresses(readLog(logPath), 'c1') });
    assert.equal(sink.messages.filter((m) => m.to.some((to) => to.includes('hung'))).length, 1);
    assert.equal(again.sent, 0);
    assert.equal(again.skipped, 2);
    assert.ok(events.some((e) => e.type === 'progress' && e.status === 'skip' && e.reason === 'uncertain'));
  } finally {
    mailer.close();
    await sink.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a timeout before the message was streamed is still retried', async () => {
  let attempts = 0;
  const summary = await runCampaign({
    recipients: [recipient('a@b.co')],
    templateHtml: 'x',
    subjectTemplate: 'x',
    delayMs: 0,
    retryDelay: 1,
    mailer: { send: async () => { attempts++; return { success: false, error: 'Timeout', code: 'ETIMEDOUT' }; } },
    onEvent: () => {},
  });
  assert.equal(attempts, 3);
  assert.equal(summary.failed, 1);
  assert.deepEqual(summary.uncertain, []);
});

test('the socket timeout is long enough for a slow server to answer the DATA command', () => {
  const mailer = createMailer({ host: '127.0.0.1', port: 1, secure: false, requireTLS: false, from: 'me@x.co' });
  try {
    assert.ok(mailer.getTransport().transporter.options.socketTimeout >= 120000);
  } finally {
    mailer.close();
  }
});

test('refused recipients do not abandon open connections; a dropped link is recovered with a fresh pool', async () => {
  // Every refusal used to orphan the pool, leaving its connection open for good.
  const refused = await campaignAgainstSink({
    sink: { rcpt: (addr) => (addr.includes('bad') ? '550 5.1.1 no such user' : null) },
    addresses: [...Array.from({ length: 8 }, (_, i) => `bad${i}@example.test`), 'ok@example.test'],
  });
  assert.equal(refused.summary.sent, 1);
  assert.equal(refused.summary.failed, 8);
  assert.ok(refused.open <= 3, `${refused.open} connections left open`);

  let dropped = false;
  const unavailable = await campaignAgainstSink({
    sink: { rcpt: () => (dropped ? null : ((dropped = true), '421 4.7.0 try again later')) },
    addresses: ['one@example.test', 'two@example.test'],
  });
  assert.equal(unavailable.summary.sent, 2);
  assert.ok(unavailable.open <= 3);
});
