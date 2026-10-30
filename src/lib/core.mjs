// Shared engine behind the CLI (src/send.mjs) and the local GUI (src/gui.mjs).
//
// Parsing, rendering, inline images, SMTP transport, the resumable send log
// and the send loop live here exactly once, so the two front-ends cannot
// drift apart. Anything fatal is thrown as an Error; the callers decide
// whether that means a non-zero exit or an HTTP 400.

import { readFileSync, appendFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { extname } from 'node:path';
import nodemailer from 'nodemailer';
import { resolveSmtpConfig } from './mailer.mjs';

// ── CSV ──────────────────────────────────────────────────────────────
/** Minimal CSV parser: quoted fields, embedded commas, CRLF, BOM. */
export function parseCsv(raw) {
  const text = String(raw).replace(/^\uFEFF/, '');
  const delimiter = text.includes('\t') && !text.includes(',')
    ? '\t'
    : (text.split('\n')[0].match(/;/g) || []).length > (text.split('\n')[0].match(/,/g) || []).length
      ? ';'
      : ',';

  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === delimiter) { row.push(field); field = ''; continue; }
    if (ch === '\n') {
      row.push(field); field = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
      continue;
    }
    if (ch !== '\r') field += ch;
  }
  row.push(field);
  if (row.some((c) => c.trim() !== '')) rows.push(row);

  if (rows.length < 2) throw new Error('CSV has no data rows');

  const headers = rows[0].map((h) => h.trim().toLowerCase());
  return rows.slice(1).map((cells) => {
    const rec = {};
    headers.forEach((h, i) => { rec[h] = (cells[i] ?? '').trim(); });
    return rec;
  });
}

const EMAIL_KEYS = ['email', 'e-mail', 'email address', 'email_address', 'mail', 'email id'];
const NAME_KEYS = ['name', 'repname', 'representative', 'contact', 'contact name', 'full name'];
const COMPANY_KEYS = ['company', 'organisation', 'organization', 'firm'];

function pick(rec, keys) {
  for (const k of keys) if (rec[k]) return rec[k];
  return '';
}

export const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Validates, de-duplicates and limits a list of `{_email,_name,_company}` records. */
function finishRecords(records, limit) {
  const seen = new Set();
  const recipients = [];
  let invalid = 0;
  let duplicates = 0;

  for (const rec of records) {
    if (!emailRe.test(rec._email)) { invalid++; continue; }
    const key = rec._email.toLowerCase();
    if (seen.has(key)) { duplicates++; continue; }
    seen.add(key);
    recipients.push(rec);
  }

  const usable = Number.isFinite(limit) ? recipients.slice(0, Math.max(1, limit)) : recipients;
  return {
    recipients: usable,
    total: records.length,
    invalid,
    duplicates,
    truncated: recipients.length - usable.length,
  };
}

/**
 * Rows → valid, de-duplicated recipients with the `_email` / `_name` /
 * `_company` aliases the template uses.
 */
export function parseRecipients(raw, { limit = Infinity } = {}) {
  const rows = parseCsv(raw);
  const records = rows.map((row) => ({
    ...row,
    _email: pick(row, EMAIL_KEYS),
    _name: pick(row, NAME_KEYS),
    _company: pick(row, COMPANY_KEYS),
  }));
  return finishRecords(records, limit);
}

/**
 * Hand-typed recipients, one per line. Accepts:
 *   priya@example.com
 *   priya@example.com, Priya Shah, Sunrise Chemicals
 *   Priya Shah <priya@example.com>
 *   priya@example.com\tPriya Shah\tSunrise Chemicals
 * `#` starts a comment line.
 */
export function parseRecipientsText(text, { limit = Infinity } = {}) {
  const records = [];
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    let email = '';
    let name = '';
    let company = '';

    const angled = line.match(/^(.*?)<([^>]+)>\s*$/);
    if (angled) {
      name = angled[1].replace(/^["']|["']$/g, '').trim();
      email = angled[2].trim();
    } else {
      const parts = line.split(/\s*[,;\t]\s*/).filter((part) => part !== '');
      email = parts[0] || '';
      name = parts[1] || '';
      company = parts[2] || '';
    }

    records.push({ _email: email, _name: name, _company: company });
  }
  return finishRecords(records, limit);
}

export function recipientsFromFile(csvPath, options = {}) {
  return parseRecipients(readFileSync(csvPath, 'utf8'), options);
}

/** Writes recipients back out as a CSV the sender (and Excel) can read. */
export function recipientsToCsv(recipients) {
  const cell = (value) => {
    const text = String(value ?? '');
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = ['email,name,company'];
  for (const rec of recipients) {
    lines.push([rec._email, rec._name, rec._company].map(cell).join(','));
  }
  return `${lines.join('\n')}\n`;
}

// ── Rendering ────────────────────────────────────────────────────────
export const escapeHtml = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** `{{column}}` substitution for HTML bodies, escaped so a name cannot inject markup. */
export const render = (tpl, rec) => String(tpl).replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_, key) => {
  const k = key.toLowerCase();
  if (k === 'name') return escapeHtml(rec._name);
  if (k === 'company') return escapeHtml(rec._company);
  if (k === 'email') return escapeHtml(rec._email);
  return escapeHtml(rec[k] ?? '');
});

/**
 * `{{column}}` substitution for the subject line.
 *
 * A subject is a plain-text header, not HTML: escaping it would deliver
 * `Shah &amp; Sons` and `O&#39;Brien` to every recipient. Newlines are
 * flattened because a line break in a header is an injection primitive.
 */
export const renderSubject = (tpl, rec) => String(tpl).replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_, key) => {
  const k = key.toLowerCase();
  if (k === 'name') return String(rec._name ?? '');
  if (k === 'company') return String(rec._company ?? '');
  if (k === 'email') return String(rec._email ?? '');
  return String(rec[k] ?? '');
}).replace(/[\r\n]+/g, ' ').trim();

/** Every `{{column}}` the template actually uses, in first-seen order. */
export function templateVariables(tpl) {
  return [...new Set([...String(tpl).matchAll(/\{\{\s*([\w.-]+)\s*\}\}/g)].map((m) => m[1]))];
}

// ── Inline images ────────────────────────────────────────────────────
// Gmail blocks data: URIs, so the template's `cid:NAME` references are
// attached inline from <template>-assets/NAME.*.
// Keyed by directory and invalidated on mtime, so renaming or adding an image
// while the server is running takes effect on the next send instead of
// silently attaching nothing.
const assetCache = new Map();

export function assetFiles(dir) {
  if (!dir || !existsSync(dir)) return [];
  let stamp;
  try {
    stamp = statSync(dir).mtimeMs;
  } catch {
    return [];
  }
  const hit = assetCache.get(dir);
  if (hit && hit.stamp === stamp) return hit.files;
  const files = readdirSync(dir).filter((f) => !f.startsWith('.')).sort();
  assetCache.set(dir, { stamp, files });
  return files;
}

export function attachmentsFor(html, dir) {
  const files = assetFiles(dir);
  if (!files.length) return [];
  const cids = [...new Set([...String(html).matchAll(/cid:([^"'\s>)]+)/g)].map((m) => m[1]))];
  return cids
    .map((cid) => {
      const file = files.find((name) => name.replace(/\.[^.]+$/, '') === cid);
      return file ? { filename: file, path: `${dir}/${file}`, cid } : null;
    })
    .filter(Boolean);
}

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' };

/** Preview-only: swap `cid:` refs for data URIs so a browser iframe can show them. */
export function inlineForPreview(html, dir) {
  const files = assetFiles(dir);
  if (!files.length) return String(html);
  return String(html).replace(/cid:([^"'\s>)]+)/g, (match, cid) => {
    const file = files.find((name) => name.replace(/\.[^.]+$/, '') === cid);
    if (!file) return match;
    const mime = MIME[extname(file).toLowerCase()] || 'application/octet-stream';
    const data = readFileSync(`${dir}/${file}`).toString('base64');
    return `data:${mime};base64,${data}`;
  });
}

// ── Send log (resumability) ──────────────────────────────────────────
export function readLog(logPath) {
  if (!existsSync(logPath)) return [];
  const entries = [];
  for (const line of readFileSync(logPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { entries.push(JSON.parse(line)); } catch { /* ignore malformed line */ }
  }
  return entries;
}

/**
 * Addresses already sent for this campaign. A campaign is the unit of
 * resumability; without one, any prior send to the address counts.
 */
export function sentAddresses(entries, campaignId = '') {
  const id = String(campaignId || '').trim();
  const set = new Set();
  for (const entry of entries) {
    if (entry.status !== 'sent') continue;
    if (id && entry.campaign !== id) continue;
    set.add(String(entry.email).toLowerCase());
  }
  return set;
}

export function campaignSummaries(entries) {
  const byId = new Map();
  for (const entry of entries) {
    const id = entry.campaign || '(untagged)';
    if (!byId.has(id)) byId.set(id, { id, sent: 0, skipped: 0, failed: 0, last: null });
    const c = byId.get(id);
    if (entry.status === 'sent') c.sent++;
    else if (entry.status === 'skipped') c.skipped++;
    else if (entry.status === 'failed') c.failed++;
    if (!c.last || String(entry.at) > String(c.last)) c.last = entry.at;
  }
  return [...byId.values()].sort((a, b) => String(b.last).localeCompare(String(a.last)));
}

export const appendLog = (logPath, entry) =>
  appendFileSync(logPath, `${JSON.stringify(entry)}\n`);

// ── SMTP ─────────────────────────────────────────────────────────────
export function createMailer(cfg = resolveSmtpConfig()) {
  let transport = null;

  function getTransport() {
    if (transport) return transport;
    transport = nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      requireTLS: cfg.requireTLS,
      ...(cfg.user && cfg.pass ? { auth: { user: cfg.user, pass: cfg.pass } } : {}),
      tls: {
        minVersion: 'TLSv1.2',
        ...(process.env.SMTP_ALLOW_SELF_SIGNED === 'true' ? { rejectUnauthorized: false } : {}),
      },
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 15000,
      pool: true,
      maxConnections: 3,
    });
    return transport;
  }

  async function verify() {
    try {
      await getTransport().verify();
      return { ok: true };
    } catch (err) {
      transport = null;
      return { ok: false, error: err.message };
    }
  }

  async function send({ to, subject, html, assetsDir }) {
    const attachments = attachmentsFor(html, assetsDir);
    try {
      const info = await getTransport().sendMail({
        from: cfg.from,
        to,
        subject,
        html,
        attachments,
      });
      return { success: true, messageId: info.messageId, inline: attachments.length };
    } catch (err) {
      // Fresh socket on the next attempt — pooled connections can go stale.
      transport = null;
      return { success: false, error: err.message };
    }
  }

  function close() {
    try { transport?.close?.(); } catch { /* already gone */ }
    transport = null;
  }

  return { cfg, getTransport, verify, send, close };
}

// ── Error classification ─────────────────────────────────────────────
export const isTransient = (err) =>
  /timeout|timed out|ECONN|ETIMEDOUT|EAI_AGAIN|ESOCKET|EPIPE|socket hang up|connection closed|connection lost|421|450|451|452|try again|rate/i.test(err || '');

export const isFatal = (err) =>
  /daily user sending limit|5\.4\.5|quota|account.*disabled|authentication/i.test(err || '');

// ── Send loop ────────────────────────────────────────────────────────
/**
 * Sends the campaign sequentially, logging every outcome. Shared by the CLI
 * and the GUI so resume, retry and kill-switch rules are identical.
 *
 * onEvent receives:
 *   { type: 'progress', index, total, status: 'sent'|'skip'|'failed', email, error? }
 *   { type: 'fatal', email, error }
 *   { type: 'done', summary }
 */
export async function runCampaign({
  recipients,
  templateHtml,
  subjectTemplate,
  assetsDir,
  campaignId = '',
  alreadySent = new Set(),
  delayMs = 4000,
  mailer,
  logPath,
  onEvent = () => {},
  shouldStop = () => false,
  retryDelay = 5000,
}) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Waiting in small slices keeps "stop" responsive during the gap between
  // messages and during retry backoff, however long they are.
  const pause = async (ms) => {
    let left = ms;
    while (left > 0) {
      if (shouldStop()) return;
      const slice = Math.min(250, left);
      await sleep(slice);
      left -= slice;
    }
  };

  const total = recipients.length;

  let sent = 0, failed = 0, skipped = 0, stopped = false;
  // A broken link (network down, provider blocking the IP) fails every
  // recipient. Retrying each of them three times over a long list hammers the
  // server and delays the real fix, so stop the run after a run of these.
  let transportFailures = 0;
  const MAX_TRANSPORT_FAILURES = 10;
  const failures = [];

  for (let i = 0; i < total && !stopped; i++) {
    if (shouldStop()) { stopped = true; break; }

    const rec = recipients[i];
    const addr = rec._email;

    if (alreadySent.has(addr.toLowerCase())) {
      skipped++;
      if (logPath) appendLog(logPath, { email: addr, status: 'skipped', at: new Date().toISOString(), campaign: campaignId || null });
      onEvent({ type: 'progress', index: i + 1, total, status: 'skip', email: addr });
      continue;
    }

    const subject = renderSubject(subjectTemplate, rec);
    const html = render(templateHtml, rec);

    let result;
    for (let attempt = 1; attempt <= 3; attempt++) {
      result = await mailer.send({ to: addr, subject, html, assetsDir });
      if (result.success) break;
      if (isFatal(result.error)) {
        if (logPath) appendLog(logPath, { email: addr, status: 'failed', error: result.error, at: new Date().toISOString(), campaign: campaignId || null });
        failed++;
        stopped = true;
        onEvent({ type: 'fatal', email: addr, error: result.error });
        break;
      }
      if (!isTransient(result.error) || attempt === 3) break;
      await pause(attempt * retryDelay);
      if (shouldStop()) break;
    }

    if (!result || stopped) continue;

    if (result.success) {
      transportFailures = 0;
      sent++;
      if (logPath) appendLog(logPath, { email: addr, status: 'sent', at: new Date().toISOString(), campaign: campaignId || null });
      onEvent({ type: 'progress', index: i + 1, total, status: 'sent', email: addr });
    } else {
      failed++;
      failures.push({ email: addr, error: result.error });
      if (logPath) appendLog(logPath, { email: addr, status: 'failed', error: result.error, at: new Date().toISOString(), campaign: campaignId || null });
      onEvent({ type: 'progress', index: i + 1, total, status: 'failed', email: addr, error: result.error });

      if (isTransient(result.error)) {
        transportFailures++;
        if (transportFailures >= MAX_TRANSPORT_FAILURES) {
          stopped = true;
          onEvent({
            type: 'fatal',
            email: addr,
            error: `The mail server failed ${transportFailures} times in a row — stopped the run instead of retrying the rest: ${result.error}`,
          });
          break;
        }
      } else {
        transportFailures = 0;
      }
    }

    if (i < total - 1 && delayMs) await pause(delayMs);
  }

  const summary = { sent, failed, skipped, failures, stopped, total, logPath: logPath || null };
  onEvent({ type: 'done', summary });
  return summary;
}

export { resolveSmtpConfig };
