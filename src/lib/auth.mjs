/**
 * Password hashing for the web GUI.
 *
 * Stored form: scrypt:<N>:<r>:<p>:<salt>:<key>  (salt and key base64url).
 * Each hash carries its own random salt and the cost it was made with, so the
 * cost can be raised later without invalidating older hashes. The separator
 * is a colon, not "$", so the value survives .env files, Docker --env-file
 * and compose interpolation untouched.
 *
 *   printf '%s' 'a long passphrase' | node src/lib/auth.mjs
 *   → MAILROOM_PASSWORD_HASH=scrypt:...
 */

import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const COST = { N: 32768, r: 8, p: 1 };
const KEY_BYTES = 32;
const SALT_BYTES = 16;

/** @typedef {{ N: number, r: number, p: number }} ScryptCost */
/** @typedef {{ N: number, r: number, p: number, salt: Buffer, key: Buffer }} ParsedPasswordHash */

// scrypt needs about 128 * N * r bytes; leave headroom above that.
/**
 * @param {number} N
 * @param {number} r
 * @returns {number}
 */
const maxmemFor = (N, r) => 160 * N * r;

/**
 * @param {string} password
 * @param {Buffer} salt
 * @param {ScryptCost} cost
 * @param {number} length
 * @returns {Promise<Buffer>}
 */
const derive = (password, salt, { N, r, p }, length) => new Promise((resolveKey, reject) => {
  scrypt(password, salt, length, { N, r, p, maxmem: maxmemFor(N, r) }, (err, key) => (err ? reject(err) : resolveKey(key)));
});

/**
 * Throws unless `stored` is a well-formed scrypt hash; returns its parts.
 * @param {string | undefined} stored
 * @returns {ParsedPasswordHash}
 */
export function parsePasswordHash(stored) {
  const parts = String(stored || '').trim().split(':');
  if (parts.length !== 6 || parts[0] !== 'scrypt') {
    throw new Error('MAILROOM_PASSWORD_HASH is not a valid hash. Generate one with: node src/lib/auth.mjs');
  }
  const [N, r, p] = parts.slice(1, 4).map(Number);
  const salt = Buffer.from(parts[4], 'base64url');
  const key = Buffer.from(parts[5], 'base64url');
  const sane = Number.isInteger(N) && N >= 2 && N <= 2 ** 20 && (N & (N - 1)) === 0
    && Number.isInteger(r) && r >= 1 && r <= 32 && Number.isInteger(p) && p >= 1 && p <= 16
    && salt.length >= SALT_BYTES && key.length >= KEY_BYTES;
  if (!sane) throw new Error('MAILROOM_PASSWORD_HASH has unusable parameters. Generate a new one with: node src/lib/auth.mjs');
  return { N, r, p, salt, key };
}

/**
 * @param {string} password
 * @returns {Promise<string>}
 */
export async function hashPassword(password) {
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(String(password), salt, COST, KEY_BYTES);
  return ['scrypt', COST.N, COST.r, COST.p, salt.toString('base64url'), key.toString('base64url')].join(':');
}

/**
 * Constant-time comparison of derived keys; a malformed hash never verifies.
 * @param {string} password
 * @param {string} stored
 * @returns {Promise<boolean>}
 */
export async function verifyPassword(password, stored) {
  /** @type {ParsedPasswordHash} */
  let parsed;
  try { parsed = parsePasswordHash(stored); } catch { return false; }
  const key = await derive(String(password), parsed.salt, parsed, parsed.key.length);
  return timingSafeEqual(key, parsed.key);
}

/**
 * Parse a Cookie header without throwing on malformed percent-escapes.
 * @param {string | undefined} header
 * @returns {Record<string, string>}
 */
export function parseCookies(header) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const part of String(header || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    const raw = part.slice(eq + 1).trim();
    try { out[name] = decodeURIComponent(raw); } catch { out[name] = raw; }
  }
  return out;
}

/**
 * Bounded in-memory session token store with TTL expiration.
 * @param {{ ttlMs: number, maxSessions: number }} opts
 */
export function createSessionStore({ ttlMs, maxSessions }) {
  /** @type {Map<string, number>} */
  const sessions = new Map();
  return {
    create() {
      const now = Date.now();
      for (const [token, expiry] of sessions) if (expiry < now) sessions.delete(token);
      while (sessions.size >= maxSessions) {
        const oldest = sessions.keys().next().value;
        if (oldest !== undefined) sessions.delete(oldest);
      }
      const token = randomBytes(32).toString('hex');
      sessions.set(token, now + ttlMs);
      return token;
    },
    has(/** @type {string} */ token) {
      const expiry = sessions.get(token);
      if (!expiry) return false;
      if (expiry < Date.now()) {
        sessions.delete(token);
        return false;
      }
      return true;
    },
    delete(/** @type {string} */ token) {
      sessions.delete(token);
    },
  };
}

/**
 * Per-IP sliding-window login attempt tracker.
 * @param {{ windowMs: number, maxAttempts: number }} opts
 */
export function createLoginLimiter({ windowMs, maxAttempts }) {
  /** @type {Map<string, number[]>} */
  const attempts = new Map();
  /** @param {string} ip */
  function recent(ip) {
    const now = Date.now();
    const hits = (attempts.get(ip) || []).filter((t) => now - t < windowMs);
    if (hits.length) attempts.set(ip, hits);
    else attempts.delete(ip);
    return hits;
  }
  return {
    isBlocked: (/** @type {string} */ ip) => recent(ip).length >= maxAttempts,
    note(/** @type {string} */ ip, /** @type {boolean} */ ok) {
      if (ok) { attempts.delete(ip); return; }
      const hits = recent(ip);
      hits.push(Date.now());
      attempts.set(ip, hits);
    },
  };
}

// ── Command line: print a hash for the password given on stdin ───────
/**
 * @param {string} prompt
 * @returns {Promise<string>}
 */
function readSecret(prompt) {
  const { stdin, stderr } = process;
  if (!stdin.isTTY) {
    return new Promise((resolveText) => {
      let text = '';
      stdin.setEncoding('utf8');
      /** @param {string | Buffer} chunk */
      const onPipeData = (chunk) => { text += String(chunk); };
      stdin.on('data', onPipeData);
      stdin.on('end', () => resolveText(text.replace(/\r?\n$/, '')));
    });
  }
  stderr.write(prompt);
  return new Promise((resolveText) => {
    let text = '';
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.resume();
    /** @param {string | Buffer} chunk */
    const onData = (chunk) => {
      for (const ch of String(chunk)) {
        if (ch === '\u0003') { stderr.write('\n'); process.exit(130); }
        if (ch === '\r' || ch === '\n' || ch === '\u0004') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          stderr.write('\n');
          return resolveText(text);
        }
        if (ch === '\u007f') text = text.slice(0, -1);
        else text += ch;
      }
    };
    stdin.on('data', onData);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const password = await readSecret('Password: ');
  if (!password) {
    console.error('No password given.');
    process.exit(1);
  }
  console.log(`MAILROOM_PASSWORD_HASH=${await hashPassword(password)}`);
}
