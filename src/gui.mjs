#!/usr/bin/env node
/**
 * Mailroom web server.
 *
 *   mailroom                  → http://127.0.0.1:4173
 *   mailroom --port 5000 --open
 *   GUI_HOST=0.0.0.0 MAILROOM_TLS_CERT=cert.pem MAILROOM_TLS_KEY=key.pem
 *   GUI_HOST=0.0.0.0 MAILROOM_ALLOW_INSECURE=1 (plain HTTP behind a TLS proxy)
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
 *   POST /api/login|logout     password session when MAILROOM_PASSWORD is set
 *   POST /api/preview          render one recipient, with images inlined
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
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import { loadConfig, saveConfig, resolveConfigPath, smtpFileValues } from './lib/config.mjs';
import { readFileSync, writeFileSync, renameSync, rmSync, existsSync, readdirSync, statSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  recipientsFromFile,
  parseRecipients,
  parseRecipientsText,
  recipientsToCsv,
  render,
  renderSubject,
  inlineForPreview,
  attachmentsFor,
  readLog,
  sentAddresses,
  campaignSummaries,
  createMailer,
  runCampaign,
  resolveSmtpConfig,
  emailRe,
} from './lib/core.mjs';

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
const LOG_PATH = resolve(process.env.SEND_LOG || join(ROOT, 'logs', 'sent.jsonl'));
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
  if (TLS_ON || ALLOW_INSECURE || isLoopbackHost(host)) return;
  throw new Error([
    `Refusing to serve Mailroom over plain HTTP on ${host}.`,
    'SMTP passwords and session cookies would cross the network unencrypted.',
    'Set MAILROOM_TLS_CERT and MAILROOM_TLS_KEY (PEM file paths) to enable HTTPS,',
    'or set MAILROOM_ALLOW_INSECURE=1 to accept the risk behind a trusted TLS proxy.',
  ].join('\n  '));
}

mkdirSync(dirname(LOG_PATH), { recursive: true });
mkdirSync(dirname(SCHEDULE_PATH), { recursive: true });

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
// Loopback-only installs need none. A Docker or LAN install must set
// MAILROOM_PASSWORD or anyone on the network can send with these credentials.
const PASSWORD = String(process.env.MAILROOM_PASSWORD || '');
const AUTH_ON = PASSWORD.length > 0;
const COOKIE = 'mr_session';
const COOKIE_SECURE = TLS_ON ? '; Secure' : '';
const SESSION_TTL = 7 * 24 * 60 * 60 * 1000;
// Sessions live in memory only: restarting the server signs everyone out.
const sessions = new Map();

function createSession() {
  const now = Date.now();
  for (const [token, expiry] of sessions) if (expiry < now) sessions.delete(token);
  const token = randomBytes(32).toString('hex');
  sessions.set(token, now + SESSION_TTL);
  return token;
}

function cookies(req) {
  const header = String(req.headers.cookie || '');
  const out = {};
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
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

function tooManyAttempts(ip) {
  const now = Date.now();
  const recent = (loginAttempts.get(ip) || []).filter((t) => now - t < 60_000);
  loginAttempts.set(ip, recent);
  return recent.length >= 8;
}

function noteAttempt(ip, ok) {
  if (ok) return loginAttempts.delete(ip);
  const now = Date.now();
  const recent = (loginAttempts.get(ip) || []).filter((t) => now - t < 60_000);
  recent.push(now);
  loginAttempts.set(ip, recent);
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
    if (size > limit) throw new Error('Request body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('Invalid JSON body');
  }
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

/** SMTP settings from a settings form, falling back to what is saved. */
function smtpConfigFrom(body) {
  const current = resolveSmtpConfig();
  const host = String(body.host ?? current.host).trim();
  const port = Number(body.port ?? current.port) || 465;
  const secure = body.secure === undefined ? port === 465 : Boolean(body.secure);
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
    isLocal,
    configured: Boolean((user && pass) || isLocal),
  };
}

function smtpState() {
  const cfg = resolveSmtpConfig();
  return {
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    user: cfg.user,
    from: cfg.from,
    configured: cfg.configured,
    passwordSet: Boolean(cfg.pass),
  };
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
  while (existsSync(candidate)) {
    candidate = join(DATA_DIR, `${slug.replace(/\.csv$/, '')}-${n}.csv`);
    n++;
  }
  return candidate;
}

/** Rendered message for one recipient, images inlined so a browser can show it. */
function previewFor(input, index = 0) {
  const i = Math.max(0, Math.min(input.parsed.recipients.length - 1, Number(index) || 0));
  const rec = input.parsed.recipients[i];
  const raw = render(input.templateHtml, rec);
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
    willSend: input.parsed.recipients.filter((r) => !input.alreadySent.has(r._email.toLowerCase())).length,
    skipped: input.parsed.recipients.filter((r) => input.alreadySent.has(r._email.toLowerCase())).length,
    invalid: input.parsed.invalid,
    duplicates: input.parsed.duplicates,
    truncated: input.parsed.truncated,
  };
}

// ── Jobs (campaign progress streams) ─────────────────────────────────
const jobs = new Map();
let activeJobId = null;

function runningJob() {
  const job = activeJobId ? jobs.get(activeJobId) : null;
  return job && !job.done ? job : null;
}

function createJob() {
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
      const verify = await mailer.verify();
      if (!verify.ok) {
        emit(job, { type: 'error', error: `Connection failed: ${verify.error}` });
        emit(job, { type: 'done', summary: { sent: 0, failed: 0, skipped: 0, failures: [], stopped: true, error: verify.error } });
        return;
      }
      emit(job, {
        type: 'start',
        total: input.parsed.recipients.length,
        skipped: input.alreadySent.size,
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
      error: entry.error || null,
      result: entry.result || null,
      createdAt: entry.createdAt || null,
    }));
}

function templateFor(entry) {
  const path = safePath(entry.template, { roots: [TEMPLATE_DIR], ext: ['.html', '.htm'] });
  return { path, html: readFileSync(path, 'utf8'), assetsDir: assetsDirFor(path) };
}

/** Runs one due entry; the caller has already marked it "sending". */
async function fireScheduled(entry, list) {
  try {
    const template = templateFor(entry);
    const campaignId = String(entry.campaign || '');
    const recipients = (entry.recipients || []).map((r) => ({
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

    const summary = await job.finished;
    entry.result = {
      sent: summary?.sent || 0,
      failed: summary?.failed || 0,
      skipped: summary?.skipped || 0,
    };
    entry.status = summary?.error || (!summary?.sent && summary?.failed) ? 'failed' : 'sent';
    if (summary?.error) entry.error = summary.error;
  } catch (err) {
    entry.status = 'failed';
    entry.error = err.message;
  } finally {
    writeSchedule(list);
  }
}

let schedulerTimer = null;
let ticking = false;

async function tick() {
  if (ticking) return;
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

    // Anything that came due long before the server was up is not sent late.
    for (const entry of list) {
      if (entry.status === 'pending' && Date.parse(entry.at) < now - GRACE_MS) {
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
    await fireScheduled(due, list);
  } catch (err) {
    console.error('[schedule] tick failed:', err.message);
  } finally {
    ticking = false;
  }
}

/**
 * A crash or restart can leave an entry marked "sending" with no job behind
 * it. Nothing is running this early in the process, so put it back in line;
 * the grace window decides whether it still goes out.
 */
function recoverSchedule() {
  const list = readSchedule();
  let changed = false;
  for (const entry of list) {
    if (entry.status !== 'sending') continue;
    entry.status = 'pending';
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
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');

  // Reject requests that did not arrive on a loopback name. Without this a
  // public DNS entry pointing at 127.0.0.1 could drive this server from a
  // browser and use the stored SMTP credentials.
  const host = String(req.headers.host || '').toLowerCase();
  if (LOOPBACK && PORT !== 0 && host && !ALLOWED_HOSTS.has(host)) {
    return fail(res, 403, 'Unexpected Host header');
  }

  const origin = String(req.headers.origin || '').toLowerCase();
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    return fail(res, 403, 'Cross-origin request refused');
  }

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

    const ip = req.socket.remoteAddress || 'local';
    if (tooManyAttempts(ip)) return fail(res, 429, 'Too many attempts — wait a minute');

    const given = Buffer.from(String(body.password || ''));
    const ok = given.length === Buffer.byteLength(PASSWORD)
      && timingSafeEqual(given, Buffer.from(PASSWORD));
    noteAttempt(ip, ok);
    if (!ok) return fail(res, 401, 'Wrong password');

    const token = createSession();
    res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800${COOKIE_SECURE}`);
    return json(res, 200, { ok: true });
  }

  if (req.method === 'POST' && pathname === '/api/logout') {
    sessions.delete(sessionOf(req));
    res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${COOKIE_SECURE}`);
    return json(res, 200, { ok: true });
  }

  const publicPath = pathname === '/login.html' || pathname === '/favicon.svg';
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
    if (!cfg.user) return fail(res, 400, 'Mailbox address is required');
    if (!cfg.pass) return fail(res, 400, 'An app password is required');
    if (!cfg.configured) return fail(res, 400, 'Those settings are incomplete');

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
    const shown = parsed.recipients.slice(0, 1000);

    return json(res, 200, {
      path: rel(csvPath),
      total: parsed.recipients.length,
      shown: shown.length,
      invalid: parsed.invalid,
      duplicates: parsed.duplicates,
      truncated: parsed.truncated,
      sentCount: parsed.recipients.filter((r) => alreadySent.has(r._email.toLowerCase())).length,
      recipients: shown.map((rec) => ({
        email: rec._email,
        name: rec._name,
        company: rec._company,
        sent: alreadySent.has(rec._email.toLowerCase()),
      })),
    });
  }

  // Save a pasted list as a CSV in data/ so it can be reused or edited.
  if (req.method === 'POST' && pathname === '/api/recipients') {
    const body = await readJson(req);
    const text = String(body.text ?? '').trim();
    if (!text) return fail(res, 400, 'Nothing to save');
    const parsed = parseRecipientsText(text);
    if (!parsed.recipients.length) return fail(res, 400, 'No valid email addresses to save');

    const target = nextCsvPath(body.name || parsed.recipients[0]._email.replace(/@.*$/, '') + '-list');
    // Write then rename, so a crash cannot leave a half-written recipient file.
    const staging = `${target}.tmp`;
    try {
      writeFileSync(staging, recipientsToCsv(parsed.recipients), 'utf8');
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
    const cfg = resolveSmtpConfig();
    if (!cfg.configured) return fail(res, 400, 'SMTP credentials are not set');

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
      html: render(input.templateHtml, rec),
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

    const delay = delayFrom(body.delay);
    let job;
    try {
      job = startCampaign(input, { delay });
    } catch (err) {
      return fail(res, err.status || 409, err.message);
    }
    return json(res, 202, { jobId: job.id, total: input.parsed.recipients.length, skipped: input.alreadySent.size });
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
      delay: delayFrom(body.delay),
      recipients: input.parsed.recipients.map((r) => ({
        email: r._email,
        name: r._name,
        company: r._company,
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
      skipped: input.alreadySent.size,
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
    const code = err.status || (/not allowed|not found|required|invalid|no valid|no data rows|expected|too long/i.test(err.message) ? 400 : 500);
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
  console.log(`  smtp      ${cfg.host}:${cfg.port} ${cfg.configured ? '(configured)' : '(set it up in the browser)'}`);
  console.log(`  config    ${rel(configFile.path)}`);
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

let shuttingDown = false;

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    if (shuttingDown) process.exit(1); // second Ctrl+C is a hard stop
    shuttingDown = true;

    if (schedulerTimer) clearInterval(schedulerTimer);

    // Stop cleanly: the message in flight finishes and is logged, the rest
    // are never started. A scheduled entry stays pending and fires on the
    // next start if it is still within the grace window.
    for (const job of jobs.values()) job.cancelled = true;

    const deadline = Date.now() + 8000;
    while (runningJob() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    server?.close(() => process.exit(0));
    if (!server) process.exit(0);
    setTimeout(() => process.exit(0), 500).unref();
  });
}

process.on('unhandledRejection', (err) => {
  console.error('[gui] unhandled rejection:', err?.message || err);
});
