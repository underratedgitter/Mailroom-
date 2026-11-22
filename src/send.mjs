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
 * Suppression: --suppress a@x.com,b@x.com adds addresses to the suppression
 * list (data/suppressed.csv, or --suppression-file / SUPPRESSION_FILE) and
 * exits. Every send, test included, skips what is on the list.
 *
 * Flags: --delay 4000 (ms between sends), --limit 100, --log logs/sent.jsonl,
 *        --campaign <id> (labels the log so a re-run resumes that campaign),
 *        --send (actually send), --test addr (single test recipient),
 *        --dump file.html (render one recipient, send nothing).
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
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
  SIGNAL_EXIT,
  describeInterruption,
  defaultSuppressionPath,
  addSuppressed,
  isSuppressed,
  rateLimitsFromEnv,
} from './lib/core.mjs';
import { loadConfig, smtpProblems } from './lib/config.mjs';
import { missingSmtpFields, configIssue } from './lib/mailer.mjs';

// Same settings the browser writes: ./.env or ~/.mailroom/config.env.
loadConfig();

const die = (msg) => {
  console.error(`\nError: ${msg}\n`);
  process.exit(1);
};

let values;
try {
  ({ values } = parseArgs({
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
      suppress: { type: 'string' },
      'suppression-file': { type: 'string' },
    },
}));
} catch (err) {
  die(err.message);
}

const suppressionPath = values['suppression-file'] ? resolve(values['suppression-file']) : defaultSuppressionPath();

if (values.suppress !== undefined) {
  const emails = values.suppress.split(/[\s,;]+/).filter(Boolean);
  if (!emails.length) die('--suppress needs at least one address');
  const result = addSuppressed(suppressionPath, emails);
  console.log(`\nsuppressed ${result.added.length} address(es) in ${suppressionPath}`);
  if (result.already.length) console.log(`  already listed: ${result.already.join(', ')}`);
  if (result.invalid.length) die(`not an email address: ${result.invalid.join(', ')}`);
  process.exit(0);
}

if (!values.csv) die('--csv is required');
if (!values.html) die('--html is required');
if (!values.subject) die('--subject is required');
if (!existsSync(values.csv)) die(`CSV not found: ${values.csv}`);
if (!existsSync(values.html)) die(`Template not found: ${values.html}`);

try {
  mkdirSync(dirname(values.log), { recursive: true });
} catch (err) {
  die(`Cannot create the log folder for ${values.log}: ${err.message}`);
}

const configProblems = smtpProblems();
if (configProblems.length) die(`Invalid configuration:\n  - ${configProblems.join('\n  - ')}`);

// Number('abc') is NaN, which would silently mean "no throttling" or "no limit".
const wholeNumber = (flag, text, min, rule) => {
  if (!/^\d+$/.test(text.trim()) || Number(text) < min) die(`${flag} must be ${rule}, got "${text}"`);
  return Number(text);
};
const delayMs = wholeNumber('--delay', values.delay, 0, 'a whole number of milliseconds');
const limit = values.limit === undefined ? Infinity : wholeNumber('--limit', values.limit, 1, 'a whole number of at least 1');

let parsed;
try {
  parsed = recipientsFromFile(values.csv, { limit });
} catch (err) {
  die(err.message);
}
const recipients = parsed.recipients;

if (!recipients.length) die('No valid email addresses found in the CSV');

let limits;
try {
  limits = rateLimitsFromEnv();
} catch (err) {
  die(err.message);
}

const campaignId = String(values.campaign || '').trim();
const alreadySent = sentAddresses(readLog(values.log), campaignId);

let templateHtml;
try {
  templateHtml = readFileSync(values.html, 'utf8');
} catch (err) {
  die(`Cannot read template ${values.html}: ${err.message}`);
}
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
console.log(`  ceiling   ${limits.perHour ? `${limits.perHour} messages/hour` : 'no hourly limit'}${limits.perDomainPerHour ? `, ${limits.perDomainPerHour} per domain` : ''}`);
const held = recipients.filter((rec) => isSuppressed(suppressionPath, rec._email)).length;
if (held) console.log(`  suppressed ${held} (will skip)`);
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
  die(`SMTP is not configured: missing ${missingSmtpFields(cfg).join(', ')}.
  Set them in the environment, in ./.env or ~/.mailroom/config.env, or save them in the browser (npm start), then re-run.`);
}

// A signal during a campaign finishes the message in flight, records it, and
// stops. The run exits non-zero so a script or scheduler knows it is unfinished.
let stopSignal = null;
if (!values.dump && !values.test) {
  for (const signal of Object.keys(SIGNAL_EXIT)) {
    process.on(signal, () => {
      if (stopSignal) {
        console.error('\nSecond signal: exiting now. A message in flight may not have been recorded.');
        process.exit(SIGNAL_EXIT[signal]);
      }
      stopSignal = signal;
      console.error(`\n${signal} received: finishing the message in flight, then stopping (signal again to quit now).`);
    });
  }
}

const issue = configIssue(cfg);
if (issue) die(issue);

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
  if (isSuppressed(suppressionPath, values.test)) {
    mailer.close();
    die(`${values.test} is on the suppression list`);
  }
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
let summary;
try {
  summary = await runCampaign({
    recipients,
    templateHtml,
    subjectTemplate,
    assetsDir,
    campaignId,
    alreadySent,
    suppressionPath,
    limits,
    delayMs,
    mailer,
    logPath: values.log,
    shouldStop: () => stopSignal !== null,
    onEvent: (event) => {
      if (event.type === 'progress') {
        const n = `[${event.index}/${event.total}]`;
        if (event.status === 'skip') console.log(`${n} skip   ${event.email} (${{ suppressed: 'suppressed', uncertain: 'earlier attempt unconfirmed' }[event.reason] || 'already sent'})`);
        else if (event.status === 'sent') console.log(`${n} sent   ${event.email}`);
        else if (event.status === 'uncertain') console.log(`${n} UNCONFIRMED ${event.email} — ${event.error}`);
        else console.log(`${n} FAILED ${event.email} — ${event.error}`);
      } else if (event.type === 'throttle') {
        const minutes = Math.ceil(event.waitMs / 60000);
        console.log(`        waiting ~${minutes} min: ${event.scope === 'hour' ? 'hourly send ceiling' : `${event.scope} ceiling`} reached (Ctrl+C to stop; re-run to resume)`);
      } else if (event.type === 'fatal') {
        console.error(`\nFATAL: ${event.error}\nStopping so the mailbox is not locked.`);
      }
    },
  });
} catch (err) {
  mailer.close();
  die(err.message);
}

mailer.close();

console.log('\nDone');
console.log('────');
console.log(`  sent    ${summary.sent}`);
console.log(`  failed  ${summary.failed}`);
console.log(`  skipped ${summary.skipped}`);
if (summary.uncertain.length) console.log(`  unconfirmed ${summary.uncertain.length} (no reply after the message was sent; it may have been delivered)`);
if (summary.suppressed) console.log(`  suppressed ${summary.suppressed} (on the suppression list)`);
console.log(`  log     ${values.log}`);
if (summary.failures.length) {
  console.log('\nFailures');
  for (const f of summary.failures) console.log(`  ${f.email} — ${f.error}`);
  process.exitCode = 1;
}
if (summary.uncertain.length) {
  console.log('\nUnconfirmed: the server may have accepted these, so they are not retried or mailed again on resume.');
  console.log('Check your Sent folder; to mail one again anyway, use a new --campaign name.');
  for (const u of summary.uncertain) console.log(`  ${u.email} — ${u.error}`);
  process.exitCode = 1;
}
if (summary.stopped) process.exitCode = 1;
if (stopSignal && summary.remaining > 0) {
  console.error(`\n${describeInterruption(stopSignal, summary, {
    campaign: campaignId,
    resume: `Run the same command again${campaignId ? `, keeping --campaign ${campaignId},` : ' with --campaign <name>'} to resume; addresses already sent are skipped.`,
  })}\n`);
  process.exitCode = SIGNAL_EXIT[stopSignal];
}
