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
 * hand editing and no `--env-file` requirement. API endpoints live under
 * `src/routes/`, plus public `GET|POST /unsubscribe`; file paths are
 * restricted to `data/` and `templates/`.
 */

import http from 'node:http';
import https from 'node:https';
import { createLoginLimiter, createSessionStore, hashPassword, parseCookies, parsePasswordHash, verifyPassword } from './lib/auth.mjs';
import { loadConfig, assertConfig } from './lib/config.mjs';
import { errMsg, errCode, errStatus } from './lib/errors.mjs';
import { dispatchApi, fail, json, readJson } from './routes/index.mjs';
import { rel as relInScope } from './routes/templates.mjs';
import { runningJob } from './routes/send.mjs';
import { startScheduler, stopScheduler, isTicking } from './routes/schedule.mjs';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  escapeHtml,
  defaultLogPath,
  defaultSuppressionPath,
  loadOrCreateUnsubscribeSecret,
  verifyUnsubscribeToken,
  addSuppressed,
  resolveSmtpConfig,
  SIGNAL_EXIT,
  describeInterruption,
} from './lib/core.mjs';
import { missingSmtpFields } from './lib/mailer.mjs';

/** @typedef {import('node:http').IncomingMessage} IncomingMessage */
/** @typedef {import('node:http').ServerResponse} ServerResponse */
/** @typedef {import('node:http').Server | import('node:https').Server} WebServer */
/** @typedef {import('node:net').AddressInfo | string | null} ListenAddress */
/** @typedef {import('./lib/core.mjs').CampaignRunSummary} CampaignRunSummary */
/** @typedef {import('./routes/index.mjs').ServerState} ServerState */

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

/** @param {string} host */
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
    throw new Error(`Cannot read the TLS certificate or key: ${errMsg(err)}`);
  }
}

/** @param {string} host */
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
const PUBLIC_URL = (process.env.MAILROOM_PUBLIC_URL || '').trim().replace(/\/+$/, '');
const { PUBLIC_URL_HOST, PUBLIC_URL_ORIGIN, PUBLIC_UNSUB_PATH } = (() => {
  try {
    if (!PUBLIC_URL) return { PUBLIC_URL_HOST: '', PUBLIC_URL_ORIGIN: '', PUBLIC_UNSUB_PATH: '' };
    const u = new URL(PUBLIC_URL);
    const base = u.pathname.replace(/\/+$/, '');
    return {
      PUBLIC_URL_HOST: u.host.toLowerCase(),
      PUBLIC_URL_ORIGIN: u.origin.toLowerCase(),
      PUBLIC_UNSUB_PATH: base ? `${base}/unsubscribe` : '',
    };
  } catch {
    return { PUBLIC_URL_HOST: '', PUBLIC_URL_ORIGIN: '', PUBLIC_UNSUB_PATH: '' };
  }
})();

/** @param {string} pathname */
const isUnsubscribePath = (pathname) => pathname === '/unsubscribe' || (PUBLIC_UNSUB_PATH !== '' && pathname === PUBLIC_UNSUB_PATH);

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

/** @type {unknown} */
let hashError = null;
if (PASSWORD_HASH) {
  try { parsePasswordHash(PASSWORD_HASH); } catch (err) { hashError = err; }
}

/** @type {Promise<string> | null} */
let memoryHash = null;
const storedHash = () => PASSWORD_HASH || (memoryHash ??= hashPassword(PASSWORD));

// Behind a reverse proxy that terminates TLS, the proxy's X-Forwarded-* headers
// say how the browser really connected. They are honoured only when asked for:
// otherwise any client could claim to be on HTTPS or spoof its address.
const TRUST_PROXY = /^(1|true|yes)$/i.test(String(process.env.MAILROOM_TRUST_PROXY || '').trim());
/** @param {IncomingMessage} req @param {string} name */
const lastForwarded = (req, name) => (String(req.headers[name] || '').split(',').pop() ?? '').trim();
/** @param {IncomingMessage} req @param {string} name */
const firstForwarded = (req, name) => (String(req.headers[name] || '').split(',')[0] ?? '').trim();

/** @param {IncomingMessage} req */
const isSecureRequest = (req) => TLS_ON || (TRUST_PROXY && firstForwarded(req, 'x-forwarded-proto').toLowerCase() === 'https');
/** @param {IncomingMessage} req */
const clientIp = (req) => (TRUST_PROXY && lastForwarded(req, 'x-forwarded-for')) || req.socket.remoteAddress || 'local';

const COOKIE = 'mr_session';
const DEFAULT_SESSION_SECONDS = 12 * 60 * 60;
const configuredTtl = Number(process.env.MAILROOM_SESSION_TTL_SECONDS);
const SESSION_SECONDS = Number.isFinite(configuredTtl) && configuredTtl > 0 ? Math.floor(configuredTtl) : DEFAULT_SESSION_SECONDS;
// Sessions live in memory only: restarting the server signs everyone out.
const sessions = createSessionStore({ ttlMs: SESSION_SECONDS * 1000, maxSessions: 100 });
const loginLimiter = createLoginLimiter({ windowMs: 60_000, maxAttempts: 8 });

/** @param {IncomingMessage} req @param {string} token @param {number} maxAgeSeconds */
function sessionCookie(req, token, maxAgeSeconds) {
  const secure = isSecureRequest(req) ? '; Secure' : '';
  return `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}${secure}`;
}

/** @param {IncomingMessage} req */
const sessionOf = (req) => String(parseCookies(req.headers.cookie)[COOKIE] || '');
/** @param {IncomingMessage} req */
const isAuthed = (req) => !AUTH_ON || sessions.has(sessionOf(req));

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

/** @param {IncomingMessage} req @param {ServerResponse} res */
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

/** @param {IncomingMessage} req @param {string} [rawPath] @returns {string | null} */
function crossSiteReason(req, rawPath = '') {
  const origin = String(req.headers.origin || '').toLowerCase();
  if (origin) {
    let originHost = null;
    try { originHost = new URL(origin).host; } catch { /* "null" and junk are foreign */ }
    const ownHost = String((TRUST_PROXY && firstForwarded(req, 'x-forwarded-host')) || req.headers.host || '').toLowerCase();
    const publicUnsubOrigin = isUnsubscribePath(rawPath) && PUBLIC_URL_ORIGIN && origin === PUBLIC_URL_ORIGIN;
    if (!ALLOWED_ORIGINS.has(origin) && !publicUnsubOrigin && !(originHost && originHost === ownHost)) return 'Cross-origin request refused';
  }
  // Modern browsers label every request; same-site (a sibling subdomain) is
  // still not us.
  const site = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  if (req.method && !SAFE_METHODS.has(req.method) && site && site !== 'same-origin' && site !== 'none') {
    return 'Cross-site request refused';
  }
  return null;
}

/**
 * @param {IncomingMessage} req
 * @param {number} [limit]
 * @returns {Promise<string>}
 */
async function readSmallBody(req, limit = 8192) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('Request body too large'), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * @param {ServerResponse} res
 * @param {number} code
 * @param {{ title: string, heading: string, message: string, token?: string, actionPath?: string }} opts
 */
function renderUnsubscribePage(res, code, { title, heading, message, token = '', actionPath = '/unsubscribe' }) {
  const form = token
    ? `<form method="POST" action="${escapeHtml(actionPath)}"><input type="hidden" name="token" value="${escapeHtml(token)}"><button type="submit">Unsubscribe</button></form>`
    : '';
  const body = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; font-family: system-ui, -apple-system, sans-serif; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; background: Canvas; color: CanvasText; }
  main { max-width: 440px; width: 100%; padding: 28px; border: 1px solid color-mix(in srgb, CanvasText 15%, transparent); border-radius: 12px; }
  h1 { margin: 0 0 12px; font-size: 20px; }
  p { margin: 0 0 18px; line-height: 1.5; }
  button { font: inherit; font-weight: 600; padding: 10px 18px; border-radius: 8px; border: 0; background: #1d4ed8; color: #fff; cursor: pointer; }
  code { font-family: ui-monospace, monospace; word-break: break-all; }
</style>
</head>
<body>
<main>
  <h1>${escapeHtml(heading)}</h1>
  <p>${message}</p>
  ${form}
</main>
</body>
</html>`;
  res.statusCode = code;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Length', Buffer.byteLength(body));
  res.end(body);
}

/** @param {string} absolute */
const rel = (absolute) => relInScope(absolute, serverState);

/** Set by the signal handler; no new campaign may start once it is true. */
let shuttingDown = false;

/** @type {ServerState} */
const serverState = {
  root: ROOT,
  dataDir: DATA_DIR,
  templateDir: TEMPLATE_DIR,
  logPath: LOG_PATH,
  suppressionPath: SUPPRESSION_PATH,
  schedulePath: SCHEDULE_PATH,
  graceMs: GRACE_MS,
  tickMs: TICK_MS,
  appVersion: APP_VERSION,
  authOn: AUTH_ON,
  configFilePath: configFile.path,
  isShuttingDown: () => shuttingDown,
};

// ── Static page ──────────────────────────────────────────────────────
/** @type {Record<string, [string, string]>} */
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/login.html': ['login.html', 'text/html; charset=utf-8'],
  '/login.css': ['login.css', 'text/css; charset=utf-8'],
  '/login.js': ['login.js', 'text/javascript; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
};

const JS_MODULE_PATH_RE = /^\/js\/([a-z0-9-]+\.mjs)$/;

/** @param {string} pathname @returns {[string, string] | null} */
function staticEntry(pathname) {
  if (STATIC[pathname]) return STATIC[pathname];
  const match = pathname.match(JS_MODULE_PATH_RE);
  return match ? [`js/${match[1]}`, 'text/javascript; charset=utf-8'] : null;
}

/** @param {ServerResponse} res @param {string} pathname */
function serveStatic(res, pathname) {
  const entry = staticEntry(pathname);
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
/** @param {IncomingMessage} req @param {ServerResponse} res */
async function route(req, res) {
  setSecurityHeaders(req, res);

  // Reject requests that did not arrive on a loopback name. Without this a
  // public DNS entry pointing at 127.0.0.1 could drive this server from a
  // browser and use the stored SMTP credentials.
  const host = String(req.headers.host || '').toLowerCase();
  const rawPath = String(req.url || '/').split(/[?#]/)[0];
  const allowedHost = ALLOWED_HOSTS.has(host) || (isUnsubscribePath(rawPath) && PUBLIC_URL_HOST && host === PUBLIC_URL_HOST);
  if (LOOPBACK && PORT !== 0 && host && !allowedHost) {
    return fail(res, 403, 'Unexpected Host header');
  }

  const crossSite = crossSiteReason(req, rawPath);
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

  // Signed public unsubscribe endpoint (RFC 8058 one-click POST & scanner-safe GET form).
  if (isUnsubscribePath(pathname) && (req.method === 'GET' || req.method === 'POST')) {
    let token = url.searchParams.get('token') || '';
    if (req.method === 'POST') {
      const rawBody = await readSmallBody(req);
      if (!token && rawBody) {
        if (rawBody.trimStart().startsWith('{')) {
          try { token = String(JSON.parse(rawBody)?.token || ''); } catch { /* treated as missing/invalid token */ }
        } else {
          token = new URLSearchParams(rawBody).get('token') || '';
        }
      }
    }
    const verified = verifyUnsubscribeToken(token, loadOrCreateUnsubscribeSecret());
    if (!verified) {
      return renderUnsubscribePage(res, 400, {
        title: 'Invalid link — Mailroom',
        heading: 'Invalid unsubscribe link',
        message: 'This unsubscribe link is invalid or has been modified.',
        actionPath: pathname,
      });
    }
    if (req.method === 'GET') {
      return renderUnsubscribePage(res, 200, {
        title: 'Unsubscribe — Mailroom',
        heading: 'Unsubscribe from future emails?',
        message: `Confirm removal for <code>${escapeHtml(verified.email)}</code>.`,
        token,
        actionPath: pathname,
      });
    }
    addSuppressed(SUPPRESSION_PATH, [verified.email], 'unsubscribe');
    return renderUnsubscribePage(res, 200, {
      title: 'Unsubscribed — Mailroom',
      heading: 'You have been unsubscribed',
      message: `<code>${escapeHtml(verified.email)}</code> will no longer receive campaigns from this Mailroom.`,
      actionPath: pathname,
    });
  }

  // ── Password gate ──────────────────────────────────────────────────
  if (req.method === 'POST' && pathname === '/api/login') {
    const body = await readJson(req);
    if (!AUTH_ON) return json(res, 200, { ok: true });

    const ip = clientIp(req);
    if (loginLimiter.isBlocked(ip)) return fail(res, 429, 'Too many attempts — wait a minute');

    const given = typeof body.password === 'string' ? body.password : '';
    const ok = given.length > 0 && given.length <= MAX_PASSWORD_LENGTH
      && await verifyPassword(given, await storedHash());
    loginLimiter.note(ip, ok);
    if (!ok) return fail(res, 401, 'Wrong password');

    // A new login replaces the session it was made from.
    sessions.delete(sessionOf(req));
    res.setHeader('Set-Cookie', sessionCookie(req, sessions.create(), SESSION_SECONDS));
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

  if (await dispatchApi(req, res, url, serverState)) return;

  if (pathname.startsWith('/api/')) return fail(res, 404, 'Unknown endpoint');
  fail(res, 404, 'Not found');
}

/** @param {IncomingMessage} req @param {ServerResponse} res */
function handleRequest(req, res) {
  route(req, res).catch((err) => {
    if (res.headersSent) {
      res.end();
      return;
    }
    const message = errMsg(err);
    const code = errStatus(err) || (/not allowed|not found|required|invalid|no valid|no data rows|unclosed quote|expected|too long/i.test(message) ? 400 : 500);
    if (code >= 500) console.error('[gui] request failed:', message);
    fail(res, code, message);
  });
}

/**
 * HTTPS when a certificate/key pair is configured, plain HTTP otherwise.
 * @returns {WebServer}
 */
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

/** @type {WebServer | null} */
let server = null;
/** @type {Promise<ListenAddress> | null} */
let started = null;

/**
 * Starts the HTTPS/HTTP server once; safe to await more than once.
 * @param {{ port?: number, host?: string }} [options]
 * @returns {Promise<ListenAddress>}
 */
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
    loadOrCreateUnsubscribeSecret();
    server = createServer();
  } catch (err) {
    return Promise.reject(err);
  }
  const activeServer = server;
  started = new Promise((resolveListen) => {
    activeServer.listen(port, host, () => {
      activeServer.off('error', onListenError);
      startScheduler(serverState);
      resolveListen(activeServer.address());
    });
  });
  return started;
}

/** @param {unknown} err */
function onListenError(err) {
  if (errCode(err) === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} is already in use.`);
    console.error(`  Stop the other process, or run: mailroom --port 4300\n`);
  } else {
    console.error(`\n  Server error: ${errMsg(err)}\n`);
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
      console.error(`\n  ${errMsg(err)}\n`);
      process.exit(1);
    });
}

const SHUTDOWN_WAIT_MS = 8000;

/**
 * Stops the running campaign cleanly, reports it, and returns the exit code.
 * @param {string} signal
 * @returns {Promise<number>}
 */
async function shutDown(signal) {
  stopScheduler();

  // The message in flight finishes and is logged; the rest are never started.
  // A scheduled entry goes back to "pending" and resumes on the next start.
  const job = runningJob();
  if (job) job.cancelled = true;

  const deadline = Date.now() + SHUTDOWN_WAIT_MS;
  while ((runningJob() || isTicking()) && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  if (!job) return 0;

  const start = job.events.find((event) => event.type === 'start');
  const campaign = start && 'campaign' in start && start.campaign ? start.campaign : '';
  const resume = job.scheduleId
    ? 'The scheduled entry is back in the queue and resumes when Mailroom starts again (or use Run now).'
    : 'Start the same campaign again to resume; addresses already sent are skipped.';

  if (!job.done) {
    console.error(`\n  Interrupted by ${signal}: ${campaign ? `campaign "${campaign}"` : 'the campaign'} did not stop within ${SHUTDOWN_WAIT_MS / 1000}s.`);
    console.error('  The message in flight may or may not have been delivered; check the send log before running it again.\n');
    return SIGNAL_EXIT[signal];
  }
  const doneSummary = job.summary;
  if (doneSummary && 'total' in doneSummary && typeof doneSummary.total === 'number'
    && typeof doneSummary.remaining === 'number' && doneSummary.remaining > 0) {
    console.error(`\n  ${describeInterruption(signal, /** @type {CampaignRunSummary} */ (doneSummary), { campaign, resume }).replace(/\n/g, '\n  ')}\n`);
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
  console.error('[gui] unhandled rejection:', err instanceof Error ? err.message : err);
});
