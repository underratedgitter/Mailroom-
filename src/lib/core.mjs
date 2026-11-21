// Shared engine behind the CLI (src/send.mjs) and the local GUI (src/gui.mjs).
//
// Parsing, rendering, inline images, SMTP transport, the resumable send log
// and the send loop live here exactly once, so the two front-ends cannot
// drift apart. Anything fatal is thrown as an Error; the callers decide
// whether that means a non-zero exit or an HTTP 400.

import { readFileSync, appendFileSync, mkdirSync, existsSync, readdirSync, statSync, realpathSync } from 'node:fs';
import { dirname, extname, resolve, sep } from 'node:path';
import nodemailer from 'nodemailer';
import { resolveSmtpConfig, bulkFields, addressDomain } from './mailer.mjs';

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

// Characters that make a mailer split or rewrite the address (list separators,
// display-name brackets, quoting and comments) are refused outright.
export const emailRe = /^[^\s@,;:<>()[\]"\\]+@[^\s@,;:<>()[\]"\\]+\.[^\s@,;:<>()[\]"\\]+$/;

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

/** A recipient's own column; `{{constructor}}` must not reach Object.prototype. */
const field = (rec, key) => (Object.hasOwn(rec, key) ? String(rec[key] ?? '') : '');

/** `{{column}}` substitution for HTML bodies, escaped so a name cannot inject markup. */
export const render = (tpl, rec) => String(tpl).replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_, key) => {
  const k = key.toLowerCase();
  if (k === 'name') return escapeHtml(rec._name);
  if (k === 'company') return escapeHtml(rec._company);
  if (k === 'email') return escapeHtml(rec._email);
  return escapeHtml(field(rec, k));
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
  return field(rec, k);
}).replace(/[\r\n]+/g, ' ').trim();

/** Every `{{column}}` the template actually uses, in first-seen order. */
export function templateVariables(tpl) {
  return [...new Set([...String(tpl).matchAll(/\{\{\s*([\w.-]+)\s*\}\}/g)].map((m) => m[1]))];
}

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '\u00A9', reg: '\u00AE', trade: '\u2122',
  ndash: '\u2013', mdash: '\u2014', hellip: '\u2026', lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201C',
  rdquo: '\u201D', bull: '\u2022', middot: '\u00B7', euro: '\u20AC', pound: '\u00A3', rupee: '\u20B9',
};

/** One pass, so an escaped `&amp;lt;` becomes `&lt;` and not `<`. */
function decodeEntities(text) {
  return text.replace(/&(?:#(\d+)|#x([\da-f]+)|([a-z]+));/gi, (match, dec, hex, name) => {
    const code = dec !== undefined ? Number(dec) : hex !== undefined ? parseInt(hex, 16) : null;
    if (code === null) return NAMED_ENTITIES[name.toLowerCase()] ?? match;
    return code > 0 && code <= 0x10FFFF && !(code >= 0xD800 && code <= 0xDFFF) ? String.fromCodePoint(code) : match;
  });
}

/**
 * Plain-text alternative for an HTML body. Mail with no text part is a spam
 * signal and unreadable in text-only clients; links keep their address so the
 * text part is still usable.
 */
export function htmlToText(html) {
  const stripTags = (s) => s.replace(/<[^>]*>/g, '');
  const text = String(html)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(head|style|script|title)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a\s*>/gi, (_, dq, sq, bare, label) => {
      const href = decodeEntities((dq ?? sq ?? bare).trim());
      const shown = decodeEntities(stripTags(label)).trim();
      return /^(https?:|mailto:)/i.test(href) && shown && shown !== href && shown !== href.replace(/^mailto:/i, '')
        ? `${label} (${href})`
        : label;
    })
    .replace(/<img\b[^>]*?\balt\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>/gi, (_, dq, sq) => ` ${dq ?? sq} `)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<(ul|ol)\b[^>]*>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '- ')
    .replace(/<\/(p|h[1-6])\s*>/gi, '\n\n')
    .replace(/<\/(div|tr|table|li|ul|ol|blockquote)\s*>/gi, '\n')
    .replace(/<\/(td|th)\s*>/gi, ' ');

  return decodeEntities(stripTags(text))
    .split('\n')
    .map((line) => line.replace(/[ \t\u00A0]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ── Inline images ────────────────────────────────────────────────────
// Gmail blocks data: URIs, so the template's `cid:NAME` references are
// attached inline from <template>-assets/NAME.*.
// Keyed by directory and invalidated on mtime, so renaming or adding an image
// while the server is running takes effect on the next send instead of
// silently attaching nothing.
const assetCache = new Map();

function staysInside(root, path) {
  try {
    return realpathSync(path).startsWith(root + sep);
  } catch {
    return false; // dangling link
  }
}

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
  // A symlink must not turn an asset name into any file the process can read.
  const root = realpathSync(dir);
  const files = readdirSync(dir).filter((f) => !f.startsWith('.') && staysInside(root, `${dir}/${f}`)).sort();
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

// ── Suppression list ─────────────────────────────────────────────────
// Addresses that must never be mailed again (unsubscribes, complaints, hard
// bounces). One CSV, `email,reason,added`; a plain list of addresses also
// works so an export from another tool can be dropped in. The file is checked
// before every message, so an address added while a campaign runs is honoured
// by the very next send.

export const defaultSuppressionPath = (env = process.env) => resolve(env.SUPPRESSION_FILE || 'data/suppressed.csv');

const suppressionCache = new Map();

export function loadSuppressed(path) {
  let stamp;
  try {
    const stats = statSync(path);
    stamp = `${stats.mtimeMs}:${stats.size}`;
  } catch {
    suppressionCache.delete(path);
    return new Set();
  }
  const hit = suppressionCache.get(path);
  if (hit && hit.stamp === stamp) return hit.set;

  const set = new Set();
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const first = line.split(/[,;\t]/)[0].trim().replace(/^"|"$/g, '').toLowerCase();
    if (emailRe.test(first)) set.add(first);
  }
  suppressionCache.set(path, { stamp, set });
  return set;
}

export const isSuppressed = (path, email) => loadSuppressed(path).has(String(email).trim().toLowerCase());

/** Adds addresses to the list; reports which were new, already there, or not addresses. */
export function addSuppressed(path, emails, reason = 'manual') {
  const known = loadSuppressed(path);
  const added = [];
  const already = [];
  const invalid = [];
  for (const raw of emails) {
    const email = String(raw).trim().toLowerCase();
    if (!emailRe.test(email)) invalid.push(String(raw).trim());
    else if (known.has(email)) already.push(email);
    else if (!added.includes(email)) added.push(email);
  }
  if (!added.length) return { added, already, invalid };

  mkdirSync(dirname(path), { recursive: true });
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const label = String(reason || 'manual').replace(/[\r\n,;"]+/g, ' ').trim().slice(0, 80) || 'manual';
  const at = new Date().toISOString();
  const rows = added.map((email) => `${email},${label},${at}\n`).join('');
  const lead = !existing ? 'email,reason,added\n' : existing.endsWith('\n') ? '' : '\n';
  appendFileSync(path, lead + rows);
  return { added, already, invalid };
}

// ── Rate ceiling ─────────────────────────────────────────────────────
// A rolling one-hour window, so a restart or a second run cannot reset it:
// the starting point is rebuilt from the send log.
const HOUR_MS = 3600000;

/** MAX_PER_HOUR (default 500, 0 = off) and MAX_PER_DOMAIN_PER_HOUR (default off). */
export function rateLimitsFromEnv(env = process.env) {
  const read = (name, fallback) => {
    const text = env[name];
    if (text === undefined || text === '') return fallback;
    if (!/^\d+$/.test(text)) throw new Error(`${name} must be a whole number of messages per hour (0 turns it off), got "${text}"`);
    return Number(text);
  };
  return { perHour: read('MAX_PER_HOUR', 500), perDomainPerHour: read('MAX_PER_DOMAIN_PER_HOUR', 0) };
}

/**
 * `check(domain)` says how long to wait before the next send is within the
 * ceilings (`scope` is 'hour' or the throttled domain); `record` notes a send.
 * `history` is `[{ at, domain }]`, oldest first.
 */
export function createRateLimiter({ perHour = 0, perDomainPerHour = 0, history = [], now = Date.now }) {
  const sends = history.map(({ at, domain }) => ({ at: typeof at === 'number' ? at : Date.parse(at), domain }));

  // The send that must age out before another fits under `limit`.
  const releaseAt = (list, limit) => (limit && list.length >= limit ? list[list.length - limit].at + HOUR_MS : 0);

  return {
    check(domain) {
      const t = now();
      while (sends.length && sends[0].at <= t - HOUR_MS) sends.shift();
      const global = releaseAt(sends, perHour);
      const perDomain = releaseAt(sends.filter((s) => s.domain === domain), perDomainPerHour);
      if (!global && !perDomain) return { waitMs: 0, scope: null };
      return global >= perDomain
        ? { waitMs: global - t, scope: 'hour' }
        : { waitMs: perDomain - t, scope: domain };
    },
    record(domain) {
      sends.push({ at: now(), domain });
    },
  };
}

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
        text: htmlToText(html),
        attachments,
        ...bulkFields(cfg, to),
      });
      return { success: true, messageId: info.messageId, inline: attachments.length };
    } catch (err) {
      // Fresh socket on the next attempt — pooled connections can go stale.
      transport = null;
      return { success: false, error: err.message, code: err.code, responseCode: err.responseCode };
    }
  }

  function close() {
    try { transport?.close?.(); } catch { /* already gone */ }
    transport = null;
  }

  return { cfg, getTransport, verify, send, close };
}

// ── Error classification ─────────────────────────────────────────────
// Both take a send result `{ error, code?, responseCode? }` (or just the error
// text). nodemailer's structured fields win: matching words in the message
// would retry a permanent rejection that merely echoes an address such as
// "rate421@example.com". The text heuristic is the fallback for errors that
// carry neither field.
const TRANSIENT_CODES = /^(ECONN\w*|ETIMEDOUT|EAI_AGAIN|ESOCKET|EPIPE)$/;

export function isTransient(failure) {
  const { error, code, responseCode } = typeof failure === 'object' && failure ? failure : { error: failure };
  if (Number.isInteger(responseCode)) return responseCode >= 400 && responseCode < 500;
  if (code) return TRANSIENT_CODES.test(code);
  return /timeout|timed out|ECONN|ETIMEDOUT|EAI_AGAIN|ESOCKET|EPIPE|socket hang up|connection closed|connection lost|421|450|451|452|try again|rate/i.test(error || '');
}

export function isFatal(failure) {
  const { error, code } = typeof failure === 'object' && failure ? failure : { error: failure };
  if (code === 'EAUTH') return true;
  return /daily user sending limit|5\.4\.5|quota|account.*disabled|authentication/i.test(error || '');
}

// ── Send loop ────────────────────────────────────────────────────────
/**
 * Sends the campaign sequentially, logging every outcome. Shared by the CLI
 * and the GUI so resume, retry and kill-switch rules are identical.
 *
 * onEvent receives:
 *   { type: 'progress', index, total, status: 'sent'|'skip'|'failed', email, error?, reason? }
 *       (a skip's reason is 'already-sent' or 'suppressed')
 *   { type: 'throttle', email, waitMs, scope }   waiting for the hourly ceiling
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
  suppressionPath = defaultSuppressionPath(),
  limits = rateLimitsFromEnv(),
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

  // Sends from earlier runs in the last hour count against the ceiling too.
  const hourAgo = Date.now() - HOUR_MS;
  const limiter = createRateLimiter({
    ...limits,
    history: (logPath ? readLog(logPath) : [])
      .filter((e) => e.status === 'sent' && Date.parse(e.at) > hourAgo)
      .map((e) => ({ at: e.at, domain: addressDomain(e.email) })),
  });

  let sent = 0, failed = 0, skipped = 0, suppressed = 0, stopped = false;
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

    const skip = (reason) => {
      skipped++;
      if (reason === 'suppressed') suppressed++;
      if (logPath) appendLog(logPath, { email: addr, status: 'skipped', ...(reason === 'suppressed' ? { reason } : {}), at: new Date().toISOString(), campaign: campaignId || null });
      onEvent({ type: 'progress', index: i + 1, total, status: 'skip', email: addr, reason });
    };

    if (alreadySent.has(addr.toLowerCase())) { skip('already-sent'); continue; }
    // Checked afresh for every message: an unsubscribe that arrives mid-run counts.
    if (isSuppressed(suppressionPath, addr)) { skip('suppressed'); continue; }

    const domain = addressDomain(addr);
    const gate = limiter.check(domain);
    if (gate.waitMs > 0) {
      onEvent({ type: 'throttle', email: addr, waitMs: gate.waitMs, scope: gate.scope });
      await pause(gate.waitMs);
      if (shouldStop()) { stopped = true; break; }
    }

    const subject = renderSubject(subjectTemplate, rec);
    const html = render(templateHtml, rec);

    let result;
    for (let attempt = 1; attempt <= 3; attempt++) {
      result = await mailer.send({ to: addr, subject, html, assetsDir });
      if (result.success) break;
      if (isFatal(result)) {
        if (logPath) appendLog(logPath, { email: addr, status: 'failed', error: result.error, at: new Date().toISOString(), campaign: campaignId || null });
        failed++;
        failures.push({ email: addr, error: result.error });
        stopped = true;
        onEvent({ type: 'fatal', email: addr, error: result.error });
        break;
      }
      if (!isTransient(result) || attempt === 3) break;
      await pause(attempt * retryDelay);
      if (shouldStop()) break;
    }

    if (!result || stopped) continue;

    if (result.success) {
      transportFailures = 0;
      sent++;
      limiter.record(domain);
      if (logPath) appendLog(logPath, { email: addr, status: 'sent', messageId: result.messageId || null, at: new Date().toISOString(), campaign: campaignId || null });
      onEvent({ type: 'progress', index: i + 1, total, status: 'sent', email: addr });
    } else {
      failed++;
      failures.push({ email: addr, error: result.error });
      if (logPath) appendLog(logPath, { email: addr, status: 'failed', error: result.error, at: new Date().toISOString(), campaign: campaignId || null });
      onEvent({ type: 'progress', index: i + 1, total, status: 'failed', email: addr, error: result.error });

      if (isTransient(result)) {
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

  const summary = { sent, failed, skipped, suppressed, failures, stopped, total, logPath: logPath || null };
  onEvent({ type: 'done', summary });
  return summary;
}

export { resolveSmtpConfig };
