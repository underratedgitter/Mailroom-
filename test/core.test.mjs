import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, renameSync } from 'node:fs';
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
  runCampaign,
  emailRe,
} from '../src/lib/core.mjs';

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
    assert.equal(readLog(join(dir, 'fatal.jsonl')).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
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
