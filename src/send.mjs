#!/usr/bin/env node
/**
 * Mailroom — command line front end.
 *
 * Run from this folder so relative template/data paths resolve:
 *
 *   # 1. Preview only — renders the first 3 messages, sends nothing
 *   npm run send -- --csv data/recipients.csv \
 *     --html templates/newsletter.html \
 *     --assets-dir templates/newsletter-assets \
 *     --subject "Subject line"
 *
 *   # 2. Send one test to yourself
 *   npm run send -- ... --test you@yourdomain.com
 *
 *   # 3. Send to everyone (resumable)
 *   npm run send -- ... --campaign newsletter-nov --send
 *
 * The browser front end (npm start) drives the exact same engine in
 * src/lib/core.mjs.
 *
 * Flags: --delay 4000 (ms between sends), --limit 100, --log logs/sent.jsonl,
 *        --campaign <id> (labels the log so a re-run resumes that campaign),
 *        --send (actually send), --test addr (single test recipient),
 *        --dump file.html (render one recipient, send nothing).
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import {
  recipientsFromFile,
  render,
  renderSubject,
  attachmentsFor,
  readLog,
  sentAddresses,
  createMailer,
  runCampaign,
  resolveSmtpConfig,
} from './lib/core.mjs';
import { loadConfig } from './lib/config.mjs';

// Same settings the browser writes: ./.env or ~/.mailroom/config.env.
loadConfig();

const { values } = parseArgs({
  options: {
    csv: { type: 'string' },
    html: { type: 'string' },
    subject: { type: 'string' },
    'assets-dir': { type: 'string' },
    campaign: { type: 'string' },
    delay: { type: 'string', default: '4000' },
    limit: { type: 'string' },
    log: { type: 'string', default: 'logs/sent.jsonl' },
    send: { type: 'boolean', default: false },
    test: { type: 'string' },
    dump: { type: 'string' },
  },
});

const die = (msg) => {
  console.error(`\nError: ${msg}\n`);
  process.exit(1);
};

if (!values.csv) die('--csv is required');
if (!values.html) die('--html is required');
if (!values.subject) die('--subject is required');
if (!existsSync(values.csv)) die(`CSV not found: ${values.csv}`);
if (!existsSync(values.html)) die(`Template not found: ${values.html}`);

mkdirSync(dirname(values.log), { recursive: true });

const delayMs = Math.max(0, Number(values.delay) || 0);
const limit = values.limit ? Math.max(1, Number(values.limit)) : Infinity;

let parsed;
try {
  parsed = recipientsFromFile(values.csv, { limit });
} catch (err) {
  die(err.message);
}
const recipients = parsed.recipients;

if (!recipients.length) die('No valid email addresses found in the CSV');

const campaignId = String(values.campaign || '').trim();
const alreadySent = sentAddresses(readLog(values.log), campaignId);

const templateHtml = readFileSync(values.html, 'utf8');
const subjectTemplate = values.subject;
const assetsDir = values['assets-dir'];

const cfg = resolveSmtpConfig();
console.log('\nSMTP');
console.log('────');
console.log(`  host      ${cfg.host}:${cfg.port} (${cfg.secure ? 'implicit TLS' : 'STARTTLS required'})`);
console.log(`  user      ${cfg.user || '(not set)'}`);
console.log(`  from      ${cfg.from}`);
console.log(`  password  ${cfg.pass ? `${cfg.pass.slice(0, 2)}${'•'.repeat(8)}` : '(not set)'}`);
console.log(`  recipients ${recipients.length}${alreadySent.size ? ` (${alreadySent.size} already sent, will skip)` : ''}`);
console.log(`  delay     ${delayMs}ms between sends`);
if (campaignId) console.log(`  campaign  ${campaignId}`);

// ── Preview (default) — works without credentials ───────────────────
if (!values.send && !values.test && !values.dump) {
  console.log('Preview (nothing sent)');
  console.log('─────────────────────');
  for (const rec of recipients.slice(0, 3)) {
    console.log(`\n  to:      ${rec._email}`);
    console.log(`  subject: ${renderSubject(subjectTemplate, rec)}`);
    console.log(`  name:    ${rec._name || '(blank)'}`);
    console.log(`  company: ${rec._company || '(blank)'}`);
    console.log(`  inline:  ${attachmentsFor(render(templateHtml, rec), assetsDir).length} image(s)`);
  }
  console.log(`\nRendered ${recipients.length} recipient(s).`);
  if (!cfg.configured) {
    console.log('SMTP is not configured yet — set SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS/EMAIL_FROM');
    console.log('(or pass --env-file to a file that has them) before using --test or --send.');
  }
  console.log('Next: --test you@example.com  then  --send\n');
  process.exit(0);
}

if (!cfg.configured) {
  console.log('\n  SMTP is not configured. Set SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS/EMAIL_FROM');
  console.log('  (or pass --env-file to a file that has them) and re-run.\n');
  process.exit(1);
}

const mailer = createMailer(cfg);
const ok = await mailer.verify();
if (!ok.ok) {
  console.log(`\n  Connection failed: ${ok.error}`);
  console.log('  Check App Password, port/TLS mode, and outbound SMTP access.\n');
  process.exit(1);
}
console.log('  connection ok\n');

// ── Dump: render the first recipient to a file, send nothing ─────────
if (values.dump) {
  const rec = recipients[0];
  const html = render(templateHtml, rec);
  writeFileSync(values.dump, html);
  console.log(`Wrote ${values.dump} (${html.length} bytes)`);
  console.log(`  recipient: ${rec._email}\n`);
  mailer.close();
  process.exit(0);
}

// ── Test mode: one rendered message to a single address ──────────────
if (values.test) {
  const rec = { ...recipients[0], _email: values.test };
  const subject = renderSubject(subjectTemplate, rec);
  const html = render(templateHtml, rec);
  console.log(`Test send to ${values.test}`);
  console.log(`  subject: ${subject}`);
  const result = await mailer.send({ to: values.test, subject, html, assetsDir });
  console.log(`  ${result.success ? 'sent' : `FAILED: ${result.error}`}\n`);
  mailer.close();
  process.exit(result.success ? 0 : 1);
}

// ── Send ─────────────────────────────────────────────────────────────
const summary = await runCampaign({
  recipients,
  templateHtml,
  subjectTemplate,
  assetsDir,
  campaignId,
  alreadySent,
  delayMs,
  mailer,
  logPath: values.log,
  onEvent: (event) => {
    if (event.type === 'progress') {
      const n = `[${event.index}/${event.total}]`;
      if (event.status === 'skip') console.log(`${n} skip   ${event.email} (already sent)`);
      else if (event.status === 'sent') console.log(`${n} sent   ${event.email}`);
      else console.log(`${n} FAILED ${event.email} — ${event.error}`);
    } else if (event.type === 'fatal') {
      console.error(`\nFATAL: ${event.error}\nStopping so the mailbox is not locked.`);
    }
  },
});

mailer.close();

console.log('\nDone');
console.log('────');
console.log(`  sent    ${summary.sent}`);
console.log(`  failed  ${summary.failed}`);
console.log(`  skipped ${summary.skipped}`);
console.log(`  log     ${values.log}`);
if (summary.failures.length) {
  console.log('\nFailures');
  for (const f of summary.failures) console.log(`  ${f.email} — ${f.error}`);
  process.exitCode = 1;
}
if (summary.stopped) process.exitCode = 1;
