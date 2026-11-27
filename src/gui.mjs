#!/usr/bin/env node
/**
 * Mailroom web server.
 *
 *   mailroom                  → http://127.0.0.1:4173
 *   mailroom --port 5000 --open
 *   GUI_HOST=0.0.0.0 MAILROOM_TLS_CERT=cert.pem MAILROOM_TLS_KEY=key.pem
 *   GUI_HOST=0.0.0.0 MAILROOM_ALLOW_INSECURE=1 MAILROOM_TRUST_PROXY=1 (plain HTTP behind a TLS proxy)
 *
 * A single process serving one page and a small JSON API, driving the same
 * engine as the CLI (src/lib/core.mjs). SMTP details live in a config file
 * (./.env or ~/.mailroom/config.env) that the setup screen can write — no
 * hand editing and no `--env-file` requirement.
 *
 * Endpoints
 *   GET  /api/state            setup status, CSV/template inventory, log summary
 *   POST /api/settings         save SMTP settings (tests first when asked)
 *   POST /api/settings/test    authenticate with unsaved settings
 *   POST /api/login|logout     password session when MAILROOM_PASSWORD or MAILROOM_PASSWORD_HASH is set
 *   POST /api/preview          render one recipient, with images inlined, plus column and {{field}} checks
 *   POST /api/roster           who is in a saved CSV, and how its columns map to merge fields
 *   POST /api/recipients       save (or dry-run) a pasted list or an uploaded CSV into data/
 *   GET  /api/suppression      the suppression list
 *   POST /api/suppress         add addresses to it
 *   GET  /api/campaigns        all campaign summaries from the send log
 *   GET  /api/campaigns/:id/export  download formula-safe CSV (?kind=sent|failed|unsent&csv=...)
 *   GET  /api/schedule         queued campaigns (POST creates one; POST /api/schedule/:id/cancel|run)
 *   POST /api/verify           SMTP connect + auth check
 *   POST /api/test             send one real message to one address
 *   POST /api/send             start a campaign job → { jobId }
 *   GET  /api/jobs/active      the campaign still running, if any
 *   GET  /api/jobs/:id/events  server-sent event stream of progress
 *   POST /api/jobs/:id/cancel  stop after the message in flight
 *
 * File paths are restricted to data/ and templates/.
 */

import http from 'node:http';
import https from 'node:https';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { hashPassword, verifyPassword, parsePasswordHash } from './lib/auth.mjs';
import { configIssue, unsubscribeUrlIssue, bareAddress, unsubscribeLink } from './lib/mailer.mjs';
import { loadConfig, saveConfig, resolveConfigPath, smtpFileValues, assertConfig } from './lib/config.mjs';
import { readFileSync, writeFileSync, renameSync, rmSync, existsSync, readdirSync, statSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  recipientsFromFile,
  parseRecipients,
  parseRecipientsText,
  recipientsToCsv,
  columnRoles,
  templateVariables,
  linkWarnings,
  render,
  renderSubject,
  inlineForPreview,
  attachmentsFor,
  readLog,
  defaultLogPath,
  defaultSuppressionPath,
  loadSuppressed,
  addSuppressed,
  isSuppressed,
  rateLimitsFromEnv,
  sentAddresses,
  countAlreadySent,
  campaignSummaries,
  campaignDeliveryLists,
  formatReportCsv,
  createMailer,
  runCampaign,
  resolveSmtpConfig,
  emailRe,
  SIGNAL_EXIT,
  describeInterruption,
} from './lib/core.mjs';
import { missingSmtpFields } from './lib/mailer.mjs';

// Read the product config before anything looks at process.env.
const configFile = loadConfig();

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const APP_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
})();
const PUBLIC_DIR = join(ROOT, 'public');
const DATA_DIR = join(ROOT, 'data');
const TEMPLATE_DIR = join(ROOT, 'templates');
const LOG_PATH = defaultLogPath();
const SUPPRESSION_PATH = defaultSuppressionPath();
const SCHEDULE_PATH = resolve(process.env.SCHEDULE_FILE || join(ROOT, 'logs', 'schedule.json'));
// A schedule that came due while the server was off is sent if it is at most
// this late; later than that it is parked as "missed" for a human to decide.
const GRACE_MS = Number(process.env.SCHEDULE_GRACE_MS || 30 * 60 * 1000);
const TICK_MS = Number(process.env.SCHEDULER_INTERVAL_MS || 15000);

const PORT = Number(process.env.GUI_PORT || 4173);
const HOST = process.env.GUI_HOST || '127.0.0.1';

// HTTPS is optional. Point both variables at PEM files to serve the app over
// TLS; sessions then get the Secure cookie flag. A lone variable is a
// misconfiguration and is refused at startup rather than silently downgraded.
const TLS_CERT_PATH = String(process.env.MAILROOM_TLS_CERT || '').trim();
const TLS_KEY_PATH = String(process.env.MAILROOM_TLS_KEY || '').trim();
const TLS_ON = Boolean(TLS_CERT_PATH && TLS_KEY_PATH);
export const tlsEnabled = TLS_ON;

// Plain HTTP is safe only on loopback. A non-loopback bind sends SMTP
// passwords and session cookies over the network, so it needs TLS or a
// deliberate acknowledgement (a trusted proxy terminating TLS in front).
const ALLOW_INSECURE = /^(1|true|yes)$/i.test(String(process.env.MAILROOM_ALLOW_INSECURE || '').trim());

function isLoopbackHost(host) {
  const value = String(host || '').trim().toLowerCase();
  return value === '127.0.0.1' || value === '::1' || value === '[::1]' || value === 'localhost';
}

function tlsOptions() {
  if (!TLS_CERT_PATH && !TLS_KEY_PATH) return null;
  if (!TLS_CERT_PATH || !TLS_KEY_PATH) {
    throw new Error('HTTPS is half configured: set both MAILROOM_TLS_CERT and MAILROOM_TLS_KEY to PEM file paths, or neither.');
  }
  try {
    return { cert: readFileSync(TLS_CERT_PATH), key: readFileSync(TLS_KEY_PATH) };
  } catch (err) {
    throw new Error(`Cannot read the TLS certificate or key: ${err.message}`);
  }
}

function assertBindingIsSafe(host) {
  if (hashError) throw hashError;
  if (isLoopbackHost(host)) return;
  if (!TLS_ON && !ALLOW_INSECURE) {
    throw new Error([
      `Refusing to serve Mailroom over plain HTTP on ${host}.`,
      'SMTP passwords and session cookies would cross the network unencrypted.',
      'Set MAILROOM_TLS_CERT and MAILROOM_TLS_KEY (PEM file paths) to enable HTTPS,',
      'or set MAILROOM_ALLOW_INSECURE=1 to accept the risk behind a trusted TLS proxy.',
    ].join('\n  '));
  }
  if (!AUTH_ON) {
    throw new Error([
      `Refusing to serve Mailroom on ${host} without a password.`,
      'Anyone who can reach this port could send mail with your SMTP account.',
      'Set MAILROOM_PASSWORD_HASH (or MAILROOM_PASSWORD) to a long passphrase before binding beyond loopback.',
    ].join('\n  '));
  }
}

// Loopback addresses the page is allowed to arrive through. Anything else is
// a DNS-rebinding attempt: a public hostname pointed at 127.0.0.1 would let a
// web page drive this server with the stored SMTP credentials.
const LOOPBACK = isLoopbackHost(HOST);
const ALLOWED_HOSTS = new Set([
  `127.0.0.1:${PORT}`,
  `localhost:${PORT}`,
  `[::1]:${PORT}`,
  ...(process.env.GUI_ALLOWED_HOSTS || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean),
]);

// A page on another site can still POST here (a form or a no-cors fetch is
// not stopped by CORS), and the request would carry this install's SMTP
// credentials. Browsers always attach Origin to a cross-site POST, so any
// origin that is not one of our own names is refused. `Origin: null`
// (sandboxed iframe, file://) is refused too — it is not in the set.
const ALLOWED_ORIGINS = new Set([...ALLOWED_HOSTS].flatMap((h) => [`http://${h}`, `https://${h}`]));

// ── Optional password gate ───────────────────────────────────────────
// Loopback-only installs need none. A Docker or LAN install must set a
// password or anyone on the network can send with these credentials.
// MAILROOM_PASSWORD_HASH (see src/lib/auth.mjs) keeps only a salted scrypt
// hash on disk; a plaintext MAILROOM_PASSWORD still works so existing configs
// keep running, and is hashed in memory with a fresh salt before any comparison.
const PASSWORD = String(process.env.MAILROOM_PASSWORD || '');
const PASSWORD_HASH = String(process.env.MAILROOM_PASSWORD_HASH || '').trim();
const AUTH_ON = PASSWORD_HASH.length > 0 || PASSWORD.length > 0;
const MAX_PASSWORD_LENGTH = 1024;

let hashError = null;
if (PASSWORD_HASH) {
  try { parsePasswordHash(PASSWORD_HASH); } catch (err) { hashError = err; }
}

let memoryHash = null;
const storedHash = () => PASSWORD_HASH || (memoryHash ??= hashPassword(PASSWORD));

// Behind a reverse proxy that terminates TLS, the proxy's X-Forwarded-* headers
// say how the browser really connected. They are honoured only when asked for:
// otherwise any client could claim to be on HTTPS or spoof its address.
const TRUST_PROXY = /^(1|true|yes)$/i.test(String(process.env.MAILROOM_TRUST_PROXY || '').trim());
const lastForwarded = (req, name) => String(req.headers[name] || '').split(',').pop().trim();
const firstForwarded = (req, name) => String(req.headers[name] || '').split(',')[0].trim();

const isSecureRequest = (req) => TLS_ON || (TRUST_PROXY && firstForwarded(req, 'x-forwarded-proto').toLowerCase() === 'https');
const clientIp = (req) => (TRUST_PROXY && lastForwarded(req, 'x-forwarded-for')) || req.socket.remoteAddress || 'local';

const COOKIE = 'mr_session';
const DEFAULT_SESSION_SECONDS = 12 * 60 * 60;
const configuredTtl = Number(process.env.MAILROOM_SESSION_TTL_SECONDS);
const SESSION_SECONDS = Number.isFinite(configuredTtl) && configuredTtl > 0 ? Math.floor(configuredTtl) : DEFAULT_SESSION_SECONDS;
const SESSION_TTL = SESSION_SECONDS * 1000;
const MAX_SESSIONS = 100;
// Sessions live in memory only: restarting the server signs everyone out.
const sessions = new Map();

function createSession() {
  const now = Date.now();
  for (const [token, expiry] of sessions) if (expiry < now) sessions.delete(token);
  // Maps iterate in insertion order, so the oldest sessions go first.
  while (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
  const token = randomBytes(32).toString('hex');
  sessions.set(token, now + SESSION_TTL);
  return token;
}

function sessionCookie(req, token, maxAgeSeconds) {
  const secure = isSecureRequest(req) ? '; Secure' : '';
  return `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}${secure}`;
}

function cookies(req) {
  const header = String(req.headers.cookie || '');
  const out = {};
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    const raw = part.slice(eq + 1).trim();
    // A malformed escape must read as "no such session", not crash the request.
    try { out[name] = decodeURIComponent(raw); } catch { out[name] = raw; }
  }
  return out;
}

function sessionOf(req) {
  return String(cookies(req)[COOKIE] || '');
}

function isAuthed(req) {
  if (!AUTH_ON) return true;
  const token = sessionOf(req);
  const expiry = sessions.get(token);
  if (!expiry) return false;
  if (expiry < Date.now()) {
    sessions.delete(token);
    return false;
  }
  return true;
}

const loginAttempts = new Map();
const ATTEMPT_WINDOW = 60_000;
const MAX_ATTEMPTS = 8;

function recentAttempts(ip) {
  const now = Date.now();
  const recent = (loginAttempts.get(ip) || []).filter((t) => now - t < ATTEMPT_WINDOW);
  if (recent.length) loginAttempts.set(ip, recent);
  else loginAttempts.delete(ip);
  return recent;
}

function tooManyAttempts(ip) {
  return recentAttempts(ip).length >= MAX_ATTEMPTS;
}

function noteAttempt(ip, ok) {
  if (ok) return loginAttempts.delete(ip);
  const recent = recentAttempts(ip);
  recent.push(Date.now());
  loginAttempts.set(ip, recent);
}

// Scripts and styles come from our own files only. Styles also allow inline
// rules because the preview iframe is a srcdoc frame, which inherits this
// policy and shows an email whose own <style> blocks and inlined images must
// render; its sandbox attribute (no allow-scripts) is what keeps it inert.
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "font-src 'self' data: https:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join('; ');

function setSecurityHeaders(req, res) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  if (isSecureRequest(req)) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
}

// SameSite=Strict already keeps the session cookie off cross-site requests;
// these checks stop a forged request from reaching the handlers at all.
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function crossSiteReason(req) {
  const origin = String(req.headers.origin || '').toLowerCase();
  if (origin) {
    let originHost = null;
    try { originHost = new URL(origin).host; } catch { /* "null" and junk are foreign */ }
    const ownHost = String((TRUST_PROXY && firstForwarded(req, 'x-forwarded-host')) || req.headers.host || '').toLowerCase();
    if (!ALLOWED_ORIGINS.has(origin) && !(originHost && originHost === ownHost)) return 'Cross-origin request refused';
  }
  // Modern browsers label every request; same-site (a sibling subdomain) is
  // still not us.
  const site = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  if (!SAFE_METHODS.has(req.method) && site && site !== 'same-origin' && site !== 'none') {
    return 'Cross-site request refused';
  }
  return null;
}

// ── Helpers ──────────────────────────────────────────────────────────
const json = (res, code, body) => {
  const payload = JSON.stringify(body);
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Length', Buffer.byteLength(payload));
  res.end(payload);
};

const fail = (res, code, message) => json(res, code, { error: message });

async function readJson(req, limit = 2 * 1024 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('Request body too large'), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('Invalid JSON body');
  }
  // Every route reads fields off the result, so null, arrays and scalars
  // would surface as a TypeError and a 500.
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('Invalid JSON body: expected an object');
  }
  return body;
}

/** Real path of a root, whether or not the directory already exists. */
function realRoot(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function isInside(candidate, roots) {
  return roots.some((root) => candidate === root || candidate.startsWith(root + sep));
}

/** Only files inside data/ or templates/ may be referenced by the page. */
function safePath(input, { roots = [DATA_DIR, TEMPLATE_DIR], ext = null } = {}) {
  const value = String(input || '').trim();
  if (!value) throw new Error('Missing file path');
  const absolute = resolve(ROOT, value);
  if (!isInside(absolute, roots)) throw new Error(`Not allowed: ${value}`);
  if (ext && !ext.includes(extname(absolute).toLowerCase())) {
    throw new Error(`Expected ${ext.join(' / ')}: ${value}`);
  }
  if (!existsSync(absolute) || !statSync(absolute).isFile()) {
    throw new Error(`File not found: ${value}`);
  }
  // statSync and readFileSync follow symlinks, so a link placed inside data/
  // would otherwise pass the prefix check and read any file the server can.
  const real = realpathSync(absolute);
  if (!isInside(real, roots.map(realRoot))) {
    throw new Error(`Not allowed: ${value}`);
  }
  return real;
}

const rel = (absolute) => (absolute.startsWith(ROOT + sep)
  ? absolute.slice(ROOT.length + 1).split(sep).join('/')
  : absolute);

/** The `-assets` folder that sits beside a template, if there is one. */
function assetsDirFor(templatePath) {
  const guess = templatePath.replace(/\.html?$/i, '') + '-assets';
  if (!existsSync(guess) || !statSync(guess).isDirectory()) return null;
  // A symlinked assets folder must not become a window into the filesystem.
  const real = realpathSync(guess);
  return isInside(real, [realRoot(TEMPLATE_DIR)]) ? real : null;
}

function listCsvs() {
  if (!existsSync(DATA_DIR)) return [];
  return readdirSync(DATA_DIR)
    .filter((name) => name.toLowerCase().endsWith('.csv'))
    .filter((name) => join(DATA_DIR, name) !== SUPPRESSION_PATH)
    .filter((name) => !lstatSync(join(DATA_DIR, name)).isSymbolicLink())
    .sort()
    .map((name) => {
      const path = join(DATA_DIR, name);
      const item = { path: rel(path), name, recipients: 0, invalid: 0, duplicates: 0, error: null };
      try {
        const parsed = parseRecipients(readFileSync(path, 'utf8'));
        item.recipients = parsed.recipients.length;
        item.invalid = parsed.invalid;
        item.duplicates = parsed.duplicates;
      } catch (err) {
        item.error = err.message;
      }
      return item;
    });
}

function listTemplates() {
  if (!existsSync(TEMPLATE_DIR)) return [];
  return readdirSync(TEMPLATE_DIR)
    .filter((name) => /\.html?$/i.test(name))
    .filter((name) => !lstatSync(join(TEMPLATE_DIR, name)).isSymbolicLink())
    .sort()
    .map((name) => {
      const path = join(TEMPLATE_DIR, name);
      const assets = assetsDirFor(path);
      return {
        path: rel(path),
        name,
        assetsDir: assets ? rel(assets) : null,
        assets: assets ? readdirSync(assets).filter((f) => !f.startsWith('.')).length : 0,
      };
    });
}

/**
 * Gap between messages, in ms. 4 s is the CLI and UI default and keeps a
 * single mailbox inside provider rate limits; an explicit 0 is honoured but a
 * missing or nonsense value must never become an unthrottled blast.
 */
function delayFrom(value, fallback = 4000) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(10 * 60 * 1000, Math.floor(n)));
}

/** true is implicit TLS, false is STARTTLS; unspecified follows the saved mode, else the port. */
function secureFrom(value, port) {
  if (value === undefined) return resolveSmtpConfig({ ...process.env, SMTP_PORT: String(port) }).secure;
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === 'false') return value === 'true';
  throw new Error('Invalid TLS mode: secure must be true (implicit TLS) or false (STARTTLS)');
}

/** A text setting from the form: not sent keeps what is saved, empty clears it. */
const textSetting = (value, saved) => (value === undefined ? saved : String(value ?? '').trim());

/** SMTP settings from a settings form, falling back to what is saved. */
function smtpConfigFrom(body) {
  const current = resolveSmtpConfig();
  const host = String(body.host ?? current.host).trim();
  const port = Number(body.port ?? current.port) || 465;
  const secure = secureFrom(body.secure, port);
  const user = String(body.user ?? current.user).trim();
  const supplied = body.pass === undefined || body.pass === '' ? current.pass : String(body.pass);
  const pass = supplied.replace(/\s+/g, '');
  const isLocal = host === 'localhost' || host === '127.0.0.1';
  const from = (body.from !== undefined ? String(body.from).trim() : current.from) || user;

  return {
    host,
    port,
    secure,
    requireTLS: !secure && !isLocal,
    user,
    pass,
    from,
    replyTo: textSetting(body.replyTo, current.replyTo),
    unsubscribeUrl: textSetting(body.unsubscribeUrl, current.unsubscribeUrl),
    maxPerHour: textSetting(body.maxPerHour, process.env.MAX_PER_HOUR ?? ''),
    isLocal,
    configured: Boolean((user && pass) || isLocal),
  };
}

/** Why the optional delivery settings cannot be saved, or null. */
function deliverySettingsIssue(cfg) {
  if (cfg.replyTo && !emailRe.test(bareAddress(cfg.replyTo))) {
    return 'Reply-To must be an email address such as help@example.com or Help <help@example.com>';
  }
  const url = unsubscribeUrlIssue(cfg.unsubscribeUrl);
  if (url) return url;
  try {
    rateLimitsFromEnv({ MAX_PER_HOUR: cfg.maxPerHour });
  } catch (err) {
    return err.message;
  }
  return null;
}

function smtpState() {
  const cfg = resolveSmtpConfig();
  return {
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    user: cfg.user,
    from: cfg.from,
    replyTo: cfg.replyTo,
    unsubscribeUrl: cfg.unsubscribeUrl,
    maxPerHour: process.env.MAX_PER_HOUR ?? '',
    configured: cfg.configured,
    passwordSet: Boolean(cfg.pass),
  };
}

/** Why a send cannot go out compliantly (bad ceiling, From or unsubscribe URL), or null. */
function complianceIssue(cfg) {
  try {
    rateLimitsFromEnv();
  } catch (err) {
    return err.message;
  }
  return configIssue(cfg);
}

/** Shared input resolution for preview / test / send. */
function resolveInput(body) {
  const templatePath = safePath(body.html, { roots: [TEMPLATE_DIR], ext: ['.html', '.htm'] });
  const assetsDir = assetsDirFor(templatePath);
  const subject = String(body.subject ?? '').trim();
  if (!subject) throw new Error('Subject is required');

  const limit = Number(body.limit);
  const options = { limit: Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : Infinity };

  // Recipients come either from a saved CSV or from the paste box.
  const raw = typeof body.raw === 'string' ? body.raw.trim() : '';
  const csvPath = raw ? null : safePath(body.csv, { roots: [DATA_DIR], ext: ['.csv'] });
  const parsed = raw ? parseRecipientsText(raw, options) : recipientsFromFile(csvPath, options);
  if (!parsed.recipients.length) {
    throw new Error(raw ? 'No valid email addresses in the pasted list' : 'No valid email addresses found in this CSV');
  }

  const campaignId = String(body.campaign ?? '').trim();
  if (subject.length > 300) throw new Error('Subject is too long (300 characters max)');
  if (campaignId.length > 120) throw new Error('Campaign name is too long (120 characters max)');
  const alreadySent = sentAddresses(readLog(LOG_PATH), campaignId);

  return {
    csvPath,
    source: raw ? 'pasted' : csvPath,
    templatePath,
    assetsDir,
    subject,
    campaignId,
    parsed,
    alreadySent,
    templateHtml: readFileSync(templatePath, 'utf8'),
  };
}

/** data/<slug>.csv, with a numeric suffix if that name is taken. */
function nextCsvPath(name) {
  const slug = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || `recipients-${Date.now()}`;
  let candidate = join(DATA_DIR, `${slug.replace(/\.csv$/, '')}.csv`);
  let n = 2;
  // The suppression list lives in data/ too; a recipient list must never claim its name.
  while (existsSync(candidate) || candidate === SUPPRESSION_PATH) {
    candidate = join(DATA_DIR, `${slug.replace(/\.csv$/, '')}-${n}.csv`);
    n++;
  }
  return candidate;
}

/** Rendered message for one recipient, images inlined so a browser can show it. */
function previewFor(input, index = 0) {
  const i = Math.max(0, Math.min(input.parsed.recipients.length - 1, Number(index) || 0));
  const rec = input.parsed.recipients[i];
  const held = (r) => !input.alreadySent.has(r._email.toLowerCase()) && isSuppressed(SUPPRESSION_PATH, r._email);
  const suppressed = input.parsed.recipients.filter(held).length;
  const skipped = input.parsed.recipients.filter((r) => input.alreadySent.has(r._email.toLowerCase())).length;
  const cfg = resolveSmtpConfig();
  const raw = render(input.templateHtml, rec, cfg);
  const columns = columnRoles(input.parsed.columns || []);
  return {
    index: i,
    total: input.parsed.recipients.length,
    to: rec._email,
    name: rec._name,
    company: rec._company,
    subject: renderSubject(input.subject, rec),
    inline: attachmentsFor(raw, input.assetsDir).length,
    alreadySent: input.alreadySent.has(rec._email.toLowerCase()),
    source: input.source,
    html: inlineForPreview(raw, input.assetsDir),
    willSend: input.parsed.recipients.length - skipped - suppressed,
    skipped,
    suppressed,
    invalid: input.parsed.invalid,
    duplicates: input.parsed.duplicates,
    truncated: input.parsed.truncated,
    columns,
    placeholders: placeholdersFor(`${input.templateHtml} ${input.subject}`, columns),
    warnings: linkWarnings(raw, { unsubscribe: unsubscribeLink(cfg, rec._email) }),
  };
}

/** Each {{field}} the message uses, and whether the recipient list can fill it. */
function placeholdersFor(text, columns) {
  const known = new Set(columns.map((c) => c.name));
  const seen = new Set();
  const found = [];
  for (const name of templateVariables(text)) {
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const status = ['name', 'company', 'email', 'unsubscribe_url'].includes(key) ? 'builtin' : known.has(key) ? 'column' : 'missing';
    found.push({ name: key, status });
  }
  return found;
}

/** The recipient table the page shows for a saved CSV, a dry run or a pasted list. */
function rosterView(parsed, { path = null, alreadySent = new Set() } = {}) {
  const shown = parsed.recipients.slice(0, 1000);
  return {
    path,
    total: parsed.recipients.length,
    shown: shown.length,
    invalid: parsed.invalid,
    duplicates: parsed.duplicates,
    truncated: parsed.truncated,
    sentCount: parsed.recipients.filter((r) => alreadySent.has(r._email.toLowerCase())).length,
    columns: columnRoles(parsed.columns || []),
    recipients: shown.map((rec) => ({
      email: rec._email,
      name: rec._name,
      company: rec._company,
      sent: alreadySent.has(rec._email.toLowerCase()),
    })),
  };
}

// ── Jobs (campaign progress streams) ─────────────────────────────────
const jobs = new Map();
let activeJobId = null;

function runningJob() {
  const job = activeJobId ? jobs.get(activeJobId) : null;
  return job && !job.done ? job : null;
}

// Set by the signal handler; no new campaign may start once it is true.
let shuttingDown = false;

function createJob() {
  if (shuttingDown) {
    const err = new Error('Mailroom is shutting down');
    err.status = 503;
    throw err;
  }
  // One campaign at a time: two runs would double-send whatever they share.
  if (runningJob()) {
    const err = new Error('A campaign is already running — wait for it to finish');
    err.status = 409;
    throw err;
  }

  const job = {
    id: randomUUID(),
    events: [],
    clients: new Set(),
    cancelled: false,
    done: false,
    summary: null,
    startedAt: new Date().toISOString(),
  };
  job.finished = new Promise((resolve) => { job.resolveFinished = resolve; });
  jobs.set(job.id, job);
  activeJobId = job.id;

  // Keep memory bounded on a long-lived server, but never drop a live job.
  if (jobs.size > 20) {
    for (const [id, old] of jobs) {
      if (jobs.size <= 20) break;
      if (!old.done) continue;
      jobs.delete(id);
    }
  }
  return job;
}

function emit(job, event) {
  // Replay buffers thousands of lines in a big campaign; bound it.
  if (job.events.length < 20000) job.events.push(event);

  const frame = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of job.clients) client.write(frame);
  if (event.type === 'done') {
    for (const client of job.clients) client.end();
    job.clients.clear();
    job.done = true;
    job.summary = event.summary;
    job.resolveFinished?.(event.summary);
    if (activeJobId === job.id) activeJobId = null;
  }
}

/**
 * Runs a campaign in the background and streams progress through a job.
 * Used by POST /api/send and by the scheduler.
 */
function startCampaign(input, { delay = 0 } = {}) {
  const cfg = resolveSmtpConfig();
  const job = createJob();

  (async () => {
    const mailer = createMailer(cfg);
    try {
      const issue = complianceIssue(cfg);
      if (issue) throw new Error(issue);
      const verify = await mailer.verify();
      if (!verify.ok) {
        emit(job, { type: 'error', error: `Connection failed: ${verify.error}` });
        emit(job, { type: 'done', summary: { sent: 0, failed: 0, skipped: 0, failures: [], stopped: true, error: verify.error } });
        return;
      }
      emit(job, {
        type: 'start',
        total: input.parsed.recipients.length,
        skipped: countAlreadySent(input.parsed.recipients, input.alreadySent),
        delay,
        campaign: input.campaignId || null,
      });
      await runCampaign({
        recipients: input.parsed.recipients,
        templateHtml: input.templateHtml,
        subjectTemplate: input.subject,
        assetsDir: input.assetsDir,
        campaignId: input.campaignId,
        alreadySent: input.alreadySent,
        suppressionPath: SUPPRESSION_PATH,
        delayMs: delay,
        mailer,
        logPath: LOG_PATH,
        shouldStop: () => job.cancelled,
        onEvent: (event) => emit(job, event),
      });
    } catch (err) {
      emit(job, { type: 'error', error: err.message });
      emit(job, { type: 'done', summary: { sent: 0, failed: 0, skipped: 0, failures: [], stopped: true, error: err.message } });
    } finally {
      mailer.close();
    }
  })();

  return job;
}

// ── Scheduled campaigns ──────────────────────────────────────────────
// The queue lives in a JSON file next to the send log, so a restart keeps it.
// Each entry stores its recipients at the moment it was scheduled: editing a
// CSV later cannot change what a queued send will do.
function readSchedule() {
  if (!existsSync(SCHEDULE_PATH)) return [];
  try {
    const parsed = JSON.parse(readFileSync(SCHEDULE_PATH, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error('[schedule] unreadable file:', err.message);
    return [];
  }
}

function writeSchedule(entries) {
  const staging = `${SCHEDULE_PATH}.tmp`;
  try {
    writeFileSync(staging, JSON.stringify(entries, null, 2));
    renameSync(staging, SCHEDULE_PATH);
  } catch (err) {
    rmSync(staging, { force: true });
    throw err;
  }
}

function scheduleView() {
  return readSchedule()
    .slice()
    .sort((a, b) => String(a.at).localeCompare(String(b.at)))
    .map((entry) => ({
      id: entry.id,
      at: entry.at,
      campaign: entry.campaign || '',
      subject: entry.subject,
      recipients: (entry.recipients || []).length,
      template: entry.template,
      status: entry.status,
      interrupted: Boolean(entry.interrupted),
      error: entry.error || null,
      result: entry.result || null,
      createdAt: entry.createdAt || null,
    }));
}

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

function templateFor(entry) {
  const path = safePath(entry.template, { roots: [TEMPLATE_DIR], ext: ['.html', '.htm'] });
  const html = readFileSync(path, 'utf8');
  // The recipients and subject were fixed when this was scheduled; so was what
  // the person approved in the preview. Entries from before the hash existed
  // have nothing to compare with.
  if (entry.templateHash && sha256(html) !== entry.templateHash) {
    throw new Error(`Template changed since scheduling: ${entry.template} is no longer what was approved. Check it, then schedule the campaign again.`);
  }
  return { path, html, assetsDir: assetsDirFor(path) };
}

/** Runs one due entry; the caller has already marked it "sending". */
async function fireScheduled(entry) {
  // Set again below if this run is cut short too.
  entry.interrupted = false;
  try {
    const template = templateFor(entry);
    const campaignId = String(entry.campaign || '');
    const recipients = (entry.recipients || []).map((r) => ({
      ...r.fields,
      _email: r.email,
      _name: r.name || '',
      _company: r.company || '',
    }));
    if (!recipients.length) throw new Error('The scheduled list has no recipients');

    const job = startCampaign({
      recipients,
      parsed: { recipients },
      templateHtml: template.html,
      assetsDir: template.assetsDir,
      subject: entry.subject,
      campaignId,
      alreadySent: sentAddresses(readLog(LOG_PATH), campaignId),
    }, { delay: delayFrom(entry.delay) });
    job.scheduleId = entry.id;

    const summary = await job.finished;
    entry.result = {
      sent: summary?.sent || 0,
      failed: summary?.failed || 0,
      skipped: summary?.skipped || 0,
      ...(summary?.uncertain?.length ? { uncertain: summary.uncertain.length } : {}),
    };
    if (job.cancelled && summary?.remaining > 0) {
      // Stopped part-way. A shutdown puts the entry back in line so the next
      // start resumes it (the log skips whoever was already mailed); a person
      // pressing Stop means it is over.
      entry.status = shuttingDown ? 'pending' : 'cancelled';
      if (shuttingDown) {
        entry.result = null;
        entry.interrupted = true;
      }
    } else {
      entry.status = summary?.error || (!summary?.sent && summary?.failed) ? 'failed' : 'sent';
    }
    if (summary?.error) entry.error = summary.error;
  } catch (err) {
    entry.status = 'failed';
    entry.error = err.message;
  } finally {
    // A send can run for hours, during which schedules are added and
    // cancelled. Write this entry's outcome into the file as it is now rather
    // than overwriting it with the copy read before the send began.
    const current = readSchedule();
    const stored = current.find((e) => e.id === entry.id);
    if (stored) {
      stored.status = entry.status;
      if (entry.interrupted) stored.interrupted = true;
      else delete stored.interrupted;
      stored.error = entry.error ?? null;
      stored.result = entry.result ?? null;
      writeSchedule(current);
    }
  }
}

let schedulerTimer = null;
let ticking = false;

async function tick() {
  if (ticking || shuttingDown) return;
  ticking = true;
  try {
    const list = readSchedule();
    const now = Date.now();
    let changed = false;

    // Keep the queue file from growing forever: finished entries are history,
    // not state, and 60 days of it is plenty.
    const cutoff = now - 60 * 24 * 60 * 60 * 1000;
    for (let i = list.length - 1; i >= 0; i--) {
      const entry = list[i];
      const finished = entry.status !== 'pending' && entry.status !== 'sending';
      if (finished && Date.parse(entry.at) < cutoff) {
        list.splice(i, 1);
        changed = true;
      }
    }

    // Anything that came due long before the server was up is not sent late. A
    // send that was cut short is not "late": it started on time and the log
    // keeps it from mailing anyone twice, so it always carries on.
    for (const entry of list) {
      if (entry.status === 'pending' && !entry.interrupted && Date.parse(entry.at) < now - GRACE_MS) {
        entry.status = 'missed';
        entry.error = 'The server was not running at the scheduled time';
        changed = true;
      }
    }
    if (changed) writeSchedule(list);

    if (runningJob()) return;
    const due = list.find((entry) => entry.status === 'pending' && Date.parse(entry.at) <= Date.now());
    if (!due) return;

    due.status = 'sending';
    writeSchedule(list);
    await fireScheduled(due);
  } catch (err) {
    console.error('[schedule] tick failed:', err.message);
  } finally {
    ticking = false;
  }
}

/**
 * A crash or restart can leave an entry marked "sending" with no job behind
 * it. Nothing is running this early in the process, so put it back in line,
 * flagged as interrupted so it resumes whatever the grace window says.
 */
function recoverSchedule() {
  const list = readSchedule();
  let changed = false;
  for (const entry of list) {
    if (entry.status !== 'sending') continue;
    entry.status = 'pending';
    entry.interrupted = true;
    entry.error = null;
    changed = true;
  }
  if (changed) writeSchedule(list);
}

/** Starts the queue timer; safe to call twice. */
export function startScheduler() {
  if (schedulerTimer) return;
  recoverSchedule();
  schedulerTimer = setInterval(() => { tick().catch(() => {}); }, Math.max(100, TICK_MS));
  setTimeout(() => tick().catch(() => {}), 250).unref();
  return schedulerTimer;
}

// ── Static page ──────────────────────────────────────────────────────
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/login.html': ['login.html', 'text/html; charset=utf-8'],
  '/login.css': ['login.css', 'text/css; charset=utf-8'],
  '/login.js': ['login.js', 'text/javascript; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
};

function serveStatic(res, pathname) {
  const entry = STATIC[pathname];
  if (!entry) return false;
  const [file, type] = entry;
  const full = join(PUBLIC_DIR, file);
  if (!existsSync(full)) return false;
  const body = readFileSync(full);
  res.statusCode = 200;
  res.setHeader('Content-Type', type);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Length', body.length);
  res.end(body);
  return true;
}

// ── Routes ───────────────────────────────────────────────────────────
async function route(req, res) {
  setSecurityHeaders(req, res);

  // Reject requests that did not arrive on a loopback name. Without this a
  // public DNS entry pointing at 127.0.0.1 could drive this server from a
  // browser and use the stored SMTP credentials.
  const host = String(req.headers.host || '').toLowerCase();
  if (LOOPBACK && PORT !== 0 && host && !ALLOWED_HOSTS.has(host)) {
    return fail(res, 403, 'Unexpected Host header');
  }

  const crossSite = crossSiteReason(req);
  if (crossSite) return fail(res, 403, crossSite);

  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  if (req.method === 'GET' && pathname === '/favicon.ico') {
    res.statusCode = 204;
    res.end();
    return;
  }

  // Liveness only, and deliberately unauthenticated so a container health
  // check keeps working when MAILROOM_PASSWORD is set. Carries no settings.
  if (req.method === 'GET' && pathname === '/api/health') {
    return json(res, 200, { ok: true, version: APP_VERSION });
  }

  // ── Password gate ──────────────────────────────────────────────────
  if (req.method === 'POST' && pathname === '/api/login') {
    const body = await readJson(req);
    if (!AUTH_ON) return json(res, 200, { ok: true });

    const ip = clientIp(req);
    if (tooManyAttempts(ip)) return fail(res, 429, 'Too many attempts — wait a minute');

    const given = typeof body.password === 'string' ? body.password : '';
    const ok = given.length > 0 && given.length <= MAX_PASSWORD_LENGTH
      && await verifyPassword(given, await storedHash());
    noteAttempt(ip, ok);
    if (!ok) return fail(res, 401, 'Wrong password');

    // A new login replaces the session it was made from.
    sessions.delete(sessionOf(req));
    res.setHeader('Set-Cookie', sessionCookie(req, createSession(), SESSION_SECONDS));
    return json(res, 200, { ok: true });
  }

  if (req.method === 'POST' && pathname === '/api/logout') {
    sessions.delete(sessionOf(req));
    res.setHeader('Set-Cookie', sessionCookie(req, '', 0));
    return json(res, 200, { ok: true });
  }

  const publicPath = ['/login.html', '/login.css', '/login.js', '/favicon.svg'].includes(pathname);
  if (AUTH_ON && !publicPath && !isAuthed(req)) {
    if (pathname.startsWith('/api/')) return fail(res, 401, 'Sign in required');
    res.statusCode = 302;
    res.setHeader('Location', '/login.html');
    res.end();
    return;
  }

  if (req.method === 'GET' && serveStatic(res, pathname)) return;

  if (req.method === 'GET' && pathname === '/api/state') {
    const entries = readLog(LOG_PATH);
    const cfg = resolveSmtpConfig();
    return json(res, 200, {
      app: { name: 'Mailroom', version: APP_VERSION },
      smtp: smtpState(),
      setup: {
        configured: cfg.configured,
        configPath: rel(configFile.path),
        authRequired: AUTH_ON,
      },
      csvs: listCsvs(),
      templates: listTemplates(),
      log: {
        path: rel(LOG_PATH),
        entries: entries.length,
        campaigns: campaignSummaries(entries).slice(0, 12),
      },
      suppression: { path: rel(SUPPRESSION_PATH), count: loadSuppressed(SUPPRESSION_PATH).size },
      defaults: { delay: 4000, campaign: suggestedCampaign() },
      platform: process.platform,
    });
  }

  // ── Settings (setup screen) ────────────────────────────────────────
  if (req.method === 'GET' && pathname === '/api/settings') {
    const cfg = resolveSmtpConfig();
    return json(res, 200, {
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      user: cfg.user,
      from: cfg.from,
      replyTo: cfg.replyTo,
      unsubscribeUrl: cfg.unsubscribeUrl,
      maxPerHour: process.env.MAX_PER_HOUR ?? '',
      passwordSet: Boolean(cfg.pass),
      configured: cfg.configured,
      configPath: rel(configFile.path),
      authRequired: AUTH_ON,
    });
  }

  if (req.method === 'POST' && pathname === '/api/settings/test') {
    const body = await readJson(req);
    const cfg = smtpConfigFrom(body);
    if (!cfg.configured) return fail(res, 400, 'Fill in the server and the mailbox first');
    const mailer = createMailer(cfg);
    const result = await mailer.verify();
    mailer.close();
    return json(res, 200, { ...result, smtp: { host: cfg.host, port: cfg.port, user: cfg.user, from: cfg.from } });
  }

  if (req.method === 'POST' && pathname === '/api/settings') {
    const body = await readJson(req);
    const cfg = smtpConfigFrom(body);

    if (!cfg.host) return fail(res, 400, 'SMTP host is required');
    // A relay on this machine needs no sign-in, only a From address to send as.
    if (!cfg.isLocal && !cfg.user) return fail(res, 400, 'Mailbox address is required');
    if (!cfg.isLocal && !cfg.pass) return fail(res, 400, 'An app password is required');
    if (!cfg.from) return fail(res, 400, 'A From address is required');
    if (!cfg.configured) return fail(res, 400, 'Those settings are incomplete');
    // Each value becomes one line of the config file; a line break would add keys.
    if ([cfg.host, cfg.user, cfg.from, cfg.replyTo, cfg.unsubscribeUrl, cfg.maxPerHour].some((value) => /[\r\n\0]/.test(value))) {
      return fail(res, 400, 'Settings cannot contain line breaks');
    }
    const delivery = deliverySettingsIssue(cfg);
    if (delivery) return fail(res, 400, delivery);

    let verified = false;
    let verifyError = null;
    if (body.test !== false) {
      const mailer = createMailer(cfg);
      const result = await mailer.verify();
      mailer.close();
      verified = result.ok;
      verifyError = result.error || null;
    }

    if (body.test !== false && !verified) {
      return json(res, 200, { ok: false, saved: false, error: verifyError || 'Could not sign in to the mail server' });
    }

    saveConfig(smtpFileValues(cfg), configFile.path);
    return json(res, 200, { ok: true, saved: true, verified, smtp: smtpState() });
  }

  if (req.method === 'POST' && pathname === '/api/preview') {
    const body = await readJson(req);
    const input = resolveInput(body);
    return json(res, 200, previewFor(input, body.index));
  }

  // Who is in a saved CSV — shown under the picker so the list is visible.
  if (req.method === 'POST' && pathname === '/api/roster') {
    const body = await readJson(req);
    const csvPath = safePath(body.csv, { roots: [DATA_DIR], ext: ['.csv'] });
    const limit = Number(body.limit);
    const parsed = recipientsFromFile(csvPath, {
      limit: Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : Infinity,
    });
    const campaignId = String(body.campaign ?? '').trim();
    const alreadySent = sentAddresses(readLog(LOG_PATH), campaignId);
    return json(res, 200, rosterView(parsed, { path: rel(csvPath), alreadySent }));
  }

  // Save a pasted list as a CSV in data/ so it can be reused or edited.
  if (req.method === 'POST' && pathname === '/api/recipients') {
    const body = await readJson(req);
    const text = String(body.text ?? '').trim();
    // format "csv" keeps a header row and its extra columns for {{merge fields}};
    // anything else is the one-address-per-line paste format.
    const asCsv = body.format === 'csv';
    // A dry run reports what would be saved, so the page can validate as the
    // user types or picks a file, without leaving a file behind.
    if (body.dryRun === true && !text) return json(res, 200, rosterView({ recipients: [], invalid: 0, duplicates: 0, truncated: 0, columns: [] }));
    if (!text) return fail(res, 400, 'Nothing to save');
    const parsed = asCsv ? parseRecipients(text) : parseRecipientsText(text);
    if (body.dryRun === true) return json(res, 200, rosterView(parsed));
    if (!parsed.recipients.length) return fail(res, 400, 'No valid email addresses to save');

    const target = nextCsvPath(body.name || parsed.recipients[0]._email.replace(/@.*$/, '') + '-list');
    // Write then rename, so a crash cannot leave a half-written recipient file.
    const staging = `${target}.tmp`;
    try {
      writeFileSync(staging, asCsv ? `${text}\n` : recipientsToCsv(parsed.recipients), 'utf8');
      renameSync(staging, target);
    } catch (err) {
      rmSync(staging, { force: true });
      throw err;
    }
    return json(res, 201, {
      path: rel(target),
      name: target.split(sep).pop(),
      recipients: parsed.recipients.length,
      duplicates: parsed.duplicates,
      invalid: parsed.invalid,
    });
  }

  if (req.method === 'POST' && pathname === '/api/verify') {
    const cfg = resolveSmtpConfig();
    if (!cfg.configured) {
      return json(res, 200, { ok: false, error: 'SMTP credentials are not set', smtp: smtpState() });
    }
    const mailer = createMailer(cfg);
    const result = await mailer.verify();
    mailer.close();
    return json(res, 200, { ...result, smtp: smtpState() });
  }

  if (req.method === 'POST' && pathname === '/api/test') {
    if (runningJob()) return fail(res, 409, 'A campaign is running — send the test when it finishes');
    const body = await readJson(req);
    const input = resolveInput(body);
    const to = String(body.to || '').trim();
    if (!emailRe.test(to)) return fail(res, 400, 'Enter a valid test address');
    if (isSuppressed(SUPPRESSION_PATH, to)) return fail(res, 400, `${to} is on the suppression list`);
    const cfg = resolveSmtpConfig();
    if (!cfg.configured) return fail(res, 400, 'SMTP credentials are not set');
    const issue = complianceIssue(cfg);
    if (issue) return fail(res, 400, issue);

    const rec = { ...input.parsed.recipients[0], _email: to };
    const mailer = createMailer(cfg);
    const verify = await mailer.verify();
    if (!verify.ok) {
      mailer.close();
      return json(res, 200, { ok: false, error: verify.error });
    }
    const result = await mailer.send({
      to,
      subject: renderSubject(input.subject, rec),
      html: render(input.templateHtml, rec, cfg),
      assetsDir: input.assetsDir,
    });
    mailer.close();
    return json(res, 200, {
      ok: result.success,
      error: result.error || null,
      messageId: result.messageId || null,
      inline: result.inline || 0,
      from: cfg.from,
    });
  }

  if (req.method === 'POST' && pathname === '/api/send') {
    const body = await readJson(req);
    if (body.confirm !== true) return fail(res, 400, 'Send was not confirmed');
    const input = resolveInput(body);
    const cfg = resolveSmtpConfig();
    if (!cfg.configured) return fail(res, 400, 'SMTP credentials are not set');
    const issue = complianceIssue(cfg);
    if (issue) return fail(res, 400, issue);

    const delay = delayFrom(body.delay);
    let job;
    try {
      job = startCampaign(input, { delay });
    } catch (err) {
      return fail(res, err.status || 409, err.message);
    }
    return json(res, 202, { jobId: job.id, total: input.parsed.recipients.length, skipped: countAlreadySent(input.parsed.recipients, input.alreadySent) });
  }

  // ── Suppression list ──────────────────────────────────────────────
  if (req.method === 'GET' && pathname === '/api/suppression') {
    const emails = [...loadSuppressed(SUPPRESSION_PATH)].sort();
    return json(res, 200, { path: rel(SUPPRESSION_PATH), count: emails.length, emails });
  }

  // Body: { emails: "a@x.com\nb@x.com" | ["a@x.com"], reason?: "unsubscribe" }
  if (req.method === 'POST' && pathname === '/api/suppress') {
    const body = await readJson(req);
    const list = typeof body.emails === 'string' ? body.emails.split(/[\s,;]+/) : body.emails;
    if (!Array.isArray(list) || list.some((item) => typeof item !== 'string')) {
      return fail(res, 400, 'emails must be a string or an array of strings');
    }
    const emails = list.map((item) => item.trim()).filter(Boolean);
    if (!emails.length) return fail(res, 400, 'Give at least one address to suppress');
    const result = addSuppressed(SUPPRESSION_PATH, emails, typeof body.reason === 'string' ? body.reason : 'manual');
    if (!result.added.length && !result.already.length) return fail(res, 400, `Not an email address: ${result.invalid.join(', ')}`);
    return json(res, 200, { ...result, count: loadSuppressed(SUPPRESSION_PATH).size });
  }

  // ── Campaign reports & CSV export ─────────────────────────────────
  if (req.method === 'GET' && pathname === '/api/campaigns') {
    return json(res, 200, { campaigns: campaignSummaries(readLog(LOG_PATH)) });
  }

  const exportMatch = pathname.match(/^\/api\/campaigns\/([^/]+)\/export$/);
  if (req.method === 'GET' && exportMatch) {
    let campaignId;
    try {
      campaignId = decodeURIComponent(exportMatch[1]);
    } catch {
      return fail(res, 400, 'Invalid campaign name');
    }
    const kind = url.searchParams.get('kind') || 'sent';
    if (!['sent', 'failed', 'unsent'].includes(kind)) {
      return fail(res, 400, 'Invalid export kind (expected sent, failed, or unsent)');
    }
    const csvParam = url.searchParams.get('csv') || '';
    let csvRecipients = [];
    if (csvParam) {
      const csvPath = safePath(csvParam, { roots: [DATA_DIR], ext: ['.csv'] });
      if (csvPath === SUPPRESSION_PATH) throw new Error(`Not allowed: ${csvParam}`);
      csvRecipients = recipientsFromFile(csvPath).recipients;
    }
    if (kind === 'unsent' && !csvParam) {
      return fail(res, 400, 'Select a recipient list to compute unsent addresses');
    }

    const entries = readLog(LOG_PATH);
    const suppressed = loadSuppressed(SUPPRESSION_PATH);
    const lists = campaignDeliveryLists(entries, csvRecipients, campaignId, suppressed);

    let csvText;
    if (kind === 'sent') {
      csvText = formatReportCsv(lists.sent, [
        { key: 'email', label: 'email' },
        { key: 'name', label: 'name' },
        { key: 'company', label: 'company' },
        { key: 'at', label: 'sent_at' },
      ]);
    } else if (kind === 'failed') {
      csvText = formatReportCsv(lists.failed, [
        { key: 'email', label: 'email' },
        { key: 'name', label: 'name' },
        { key: 'company', label: 'company' },
        { key: 'responseCode', label: 'response_code' },
        { key: 'error', label: 'error' },
        { key: 'at', label: 'failed_at' },
      ]);
    } else {
      csvText = formatReportCsv(
        lists.unsent.map((r) => ({ email: r._email, name: r._name, company: r._company })),
        [
          { key: 'email', label: 'email' },
          { key: 'name', label: 'name' },
          { key: 'company', label: 'company' },
        ],
      );
    }

    const safeName = campaignId.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'campaign';
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}-${kind}.csv"`);
    res.setHeader('Content-Length', Buffer.byteLength(csvText));
    res.end(csvText);
    return;
  }

  // ── Scheduled campaigns ───────────────────────────────────────────
  if (req.method === 'GET' && pathname === '/api/schedule') {
    return json(res, 200, {
      entries: scheduleView(),
      now: new Date().toISOString(),
      graceMs: GRACE_MS,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
  }

  if (req.method === 'POST' && pathname === '/api/schedule') {
    const body = await readJson(req);
    const input = resolveInput(body);
    // Queueing before SMTP is set up is allowed; the run re-checks when it fires.
    const smtp = resolveSmtpConfig();
    const issue = smtp.configured ? complianceIssue(smtp) : null;
    if (issue) return fail(res, 400, issue);

    const at = Date.parse(String(body.at || ''));
    if (!Number.isFinite(at)) return fail(res, 400, 'Pick a date and time');
    if (at < Date.now() + 1000) return fail(res, 400, 'Pick a time in the future');

    const list = readSchedule();
    const active = list.filter((e) => e.status === 'pending' || e.status === 'sending').length;
    if (active >= 100) return fail(res, 400, 'Too many scheduled campaigns — finish or cancel some first');

    const entry = {
      id: randomUUID(),
      at: new Date(at).toISOString(),
      createdAt: new Date().toISOString(),
      campaign: input.campaignId,
      subject: input.subject,
      template: rel(input.templatePath),
      templateHash: sha256(input.templateHtml),
      delay: delayFrom(body.delay),
      recipients: input.parsed.recipients.map((r) => ({
        email: r._email,
        name: r._name,
        company: r._company,
        // The other CSV columns, so {{column}} in the template and subject
        // renders the same when the entry fires as it did in the preview.
        fields: Object.fromEntries(Object.entries(r).filter(([key]) => !key.startsWith('_'))),
      })),
      status: 'pending',
      error: null,
      result: null,
    };
    list.push(entry);
    writeSchedule(list);

    return json(res, 201, {
      entry: scheduleView().find((e) => e.id === entry.id),
      total: entry.recipients.length,
      skipped: countAlreadySent(input.parsed.recipients, input.alreadySent),
    });
  }

  const scheduleMatch = pathname.match(/^\/api\/schedule\/([\w-]+)\/(cancel|run)$/);
  if (req.method === 'POST' && scheduleMatch) {
    const list = readSchedule();
    const entry = list.find((e) => e.id === scheduleMatch[1]);
    if (!entry) return fail(res, 404, 'Unknown scheduled campaign');

    if (scheduleMatch[2] === 'cancel') {
      if (entry.status !== 'pending' && entry.status !== 'missed') {
        return fail(res, 409, `Cannot cancel a campaign that is ${entry.status}`);
      }
      entry.status = 'cancelled';
      writeSchedule(list);
      return json(res, 200, { ok: true });
    }

    if (entry.status === 'sending') return fail(res, 409, 'That campaign is sending already');
    if (runningJob()) return fail(res, 409, 'A campaign is already running');
    entry.at = new Date().toISOString();
    entry.status = 'pending';
    writeSchedule(list);
    tick().catch(() => {});
    return json(res, 202, { ok: true });
  }

  // Lets a reloaded page re-attach to a campaign that is still sending.
  if (req.method === 'GET' && pathname === '/api/jobs/active') {
    const job = runningJob();
    if (!job) return json(res, 200, { jobId: null });
    const start = job.events.find((event) => event.type === 'start') || {};
    return json(res, 200, {
      jobId: job.id,
      total: start.total ?? null,
      campaign: start.campaign ?? null,
      startedAt: job.startedAt,
      cancelled: job.cancelled,
    });
  }

  const eventsMatch = pathname.match(/^\/api\/jobs\/([\w-]+)\/events$/);
  if (req.method === 'GET' && eventsMatch) {
    const job = jobs.get(eventsMatch[1]);
    if (!job) return fail(res, 404, 'Unknown job');

    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.write(': connected\n\n');

    for (const event of job.events) res.write(`data: ${JSON.stringify(event)}\n\n`);
    if (job.done) return res.end();

    job.clients.add(res);

    // Keep-alive comment: a silent stream is dropped by browsers and proxies.
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => {
      clearInterval(ping);
      job.clients.delete(res);
    });
    return;
  }

  const cancelMatch = pathname.match(/^\/api\/jobs\/([\w-]+)\/cancel$/);
  if (req.method === 'POST' && cancelMatch) {
    const job = jobs.get(cancelMatch[1]);
    if (!job) return fail(res, 404, 'Unknown job');
    job.cancelled = true;
    return json(res, 200, { ok: true });
  }

  if (pathname.startsWith('/api/')) return fail(res, 404, 'Unknown endpoint');
  fail(res, 404, 'Not found');
}

function suggestedCampaign() {
  const stamp = new Date().toISOString().slice(0, 7);
  return `campaign-${stamp}`;
}

function handleRequest(req, res) {
  route(req, res).catch((err) => {
    if (res.headersSent) {
      res.end();
      return;
    }
    const code = err.status || (/not allowed|not found|required|invalid|no valid|no data rows|unclosed quote|expected|too long/i.test(err.message) ? 400 : 500);
    if (code >= 500) console.error('[gui] request failed:', err.message);
    fail(res, code, err.message);
  });
}

/** HTTPS when a certificate/key pair is configured, plain HTTP otherwise. */
function createServer() {
  const tls = tlsOptions();
  const created = tls
    ? https.createServer(tls, handleRequest)
    : http.createServer(handleRequest);

  // A stuck client must not pin the process; SSE responses are unaffected
  // because these limits cover receiving the request only.
  created.requestTimeout = 30000;
  created.headersTimeout = 15000;
  created.keepAliveTimeout = 5000;
  created.on('error', onListenError);
  return created;
}

let server = null;
let started = null;

/** Starts the HTTPS/HTTP server once; safe to await more than once. */
export function startServer({ port = PORT, host = HOST } = {}) {
  if (started) return Promise.resolve(started);
  try {
    assertConfig(process.env, {
      templatesDir: TEMPLATE_DIR,
      writableDirs: [
        { label: 'log folder', path: dirname(LOG_PATH) },
        { label: 'schedule folder', path: dirname(SCHEDULE_PATH) },
      ],
    });
    assertBindingIsSafe(host);
    server = createServer();
  } catch (err) {
    return Promise.reject(err);
  }
  started = new Promise((resolveListen) => {
    server.listen(port, host, () => {
      server.off('error', onListenError);
      startScheduler();
      resolveListen(server.address());
    });
  });
  return started;
}

function onListenError(err) {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} is already in use.`);
    console.error(`  Stop the other process, or run: mailroom --port 4300\n`);
  } else {
    console.error(`\n  Server error: ${err.message}\n`);
  }
  process.exit(1);
}

function banner() {
  const cfg = resolveSmtpConfig();
  console.log(`\n  Mailroom ${APP_VERSION}`);
  console.log(`  ─────────────`);
  console.log(`  url       ${TLS_ON ? 'https' : 'http'}://${HOST}:${PORT}`);
  const missing = missingSmtpFields(cfg);
  console.log(`  smtp      ${cfg.host}:${cfg.port} ${cfg.configured ? '(configured)' : `(missing ${missing.join(', ')}; set it up in the browser)`}`);
  console.log(`  config    ${rel(configFile.path)}`);
  if (PASSWORD && !PASSWORD_HASH) console.log('  password  stored in plaintext (MAILROOM_PASSWORD); switch to MAILROOM_PASSWORD_HASH: node src/lib/auth.mjs');
  console.log(`  log       ${rel(LOG_PATH)}`);
  if (!LOOPBACK) {
    if (!TLS_ON) console.log('  transport plain HTTP (MAILROOM_ALLOW_INSECURE=1)');
    console.log(AUTH_ON
      ? '  access    password required'
      : '  access    NO PASSWORD — anyone who can reach this port can send mail');
  }
  console.log('\n  Ctrl+C to stop.\n');
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  startServer()
    .then(banner)
    .catch((err) => {
      console.error(`\n  ${err.message}\n`);
      process.exit(1);
    });
}

const SHUTDOWN_WAIT_MS = 8000;

/** Stops the running campaign cleanly, reports it, and returns the exit code. */
async function shutDown(signal) {
  if (schedulerTimer) clearInterval(schedulerTimer);

  // The message in flight finishes and is logged; the rest are never started.
  // A scheduled entry goes back to "pending" and resumes on the next start.
  const job = runningJob();
  if (job) job.cancelled = true;

  const deadline = Date.now() + SHUTDOWN_WAIT_MS;
  while ((runningJob() || ticking) && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  if (!job) return 0;

  const start = job.events.find((event) => event.type === 'start') || {};
  const campaign = start.campaign || '';
  const resume = job.scheduleId
    ? 'The scheduled entry is back in the queue and resumes when Mailroom starts again (or use Run now).'
    : 'Start the same campaign again to resume; addresses already sent are skipped.';

  if (!job.done) {
    console.error(`\n  Interrupted by ${signal}: ${campaign ? `campaign "${campaign}"` : 'the campaign'} did not stop within ${SHUTDOWN_WAIT_MS / 1000}s.`);
    console.error('  The message in flight may or may not have been delivered; check the send log before running it again.\n');
    return SIGNAL_EXIT[signal];
  }
  if (job.summary?.remaining > 0) {
    console.error(`\n  ${describeInterruption(signal, job.summary, { campaign, resume }).replace(/\n/g, '\n  ')}\n`);
    return SIGNAL_EXIT[signal];
  }
  return 0;
}

for (const signal of Object.keys(SIGNAL_EXIT)) {
  process.on(signal, async () => {
    if (shuttingDown) {
      console.error('\n  Second signal: exiting now. A message in flight may not have been recorded.\n');
      process.exit(SIGNAL_EXIT[signal]);
    }
    shuttingDown = true;

    const code = await shutDown(signal);
    server?.close(() => process.exit(code));
    if (!server) process.exit(code);
    setTimeout(() => process.exit(code), 500).unref();
  });
}

process.on('unhandledRejection', (err) => {
  console.error('[gui] unhandled rejection:', err?.message || err);
});
