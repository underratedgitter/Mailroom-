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
// scrypt needs about 128 * N * r bytes; leave headroom above that.
const maxmemFor = (N, r) => 160 * N * r;

const derive = (password, salt, { N, r, p }, length) => new Promise((resolveKey, reject) => {
  scrypt(password, salt, length, { N, r, p, maxmem: maxmemFor(N, r) }, (err, key) => (err ? reject(err) : resolveKey(key)));
});

/** Throws unless `stored` is a well-formed scrypt hash; returns its parts. */
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

export async function hashPassword(password) {
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(String(password), salt, COST, KEY_BYTES);
  return ['scrypt', COST.N, COST.r, COST.p, salt.toString('base64url'), key.toString('base64url')].join(':');
}

/** Constant-time comparison of derived keys; a malformed hash never verifies. */
export async function verifyPassword(password, stored) {
  let parsed;
  try { parsed = parsePasswordHash(stored); } catch { return false; }
  const key = await derive(String(password), parsed.salt, parsed, parsed.key.length);
  return timingSafeEqual(key, parsed.key);
}

// ── Command line: print a hash for the password given on stdin ───────
function readSecret(prompt) {
  const { stdin, stderr } = process;
  if (!stdin.isTTY) {
    return new Promise((resolveText) => {
      let text = '';
      stdin.setEncoding('utf8');
      stdin.on('data', (chunk) => { text += chunk; });
      stdin.on('end', () => resolveText(text.replace(/\r?\n$/, '')));
    });
  }
  stderr.write(prompt);
  return new Promise((resolveText) => {
    let text = '';
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.resume();
    const onData = (chunk) => {
      for (const ch of chunk) {
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
