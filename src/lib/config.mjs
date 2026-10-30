// Configuration for a product install.
//
// The old setup required hand-editing `.env` and running Node with
// `--env-file`, which crashes when the file is missing. A product has to start
// cold, collect SMTP details in the browser, and remember them somewhere the
// process can write:
//
//   MAILROOM_CONFIG=/path/to/file   explicit
//   ./.env                          a checkout that already has one
//   ~/.mailroom/config.env          a global install
//
// Values already present in the real environment always win, so Docker and
// systemd can override the file without editing it.

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  chmodSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const KEYS = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'EMAIL_FROM', 'SMTP_SECURE'];

/** Minimal dotenv parser: comments, `export `, quoted values. */
export function parseEnv(text) {
  const values = {};
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const body = line.startsWith('export ') ? line.slice(7).trim() : line;
    const eq = body.indexOf('=');
    if (eq === -1) continue;
    const key = body.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let value = body.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function formatValue(value) {
  const text = String(value);
  return /[\s#'"\\]/.test(text) ? `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : text;
}

export function resolveConfigPath(cwd = process.cwd()) {
  if (process.env.MAILROOM_CONFIG) return resolve(process.env.MAILROOM_CONFIG);
  const local = join(cwd, '.env');
  if (existsSync(local)) return local;
  return join(homedir(), '.mailroom', 'config.env');
}

/** Loads the file into process.env without overriding real env vars. */
export function loadConfig(path = resolveConfigPath()) {
  if (!existsSync(path)) return { path, loaded: false, values: {} };
  const values = parseEnv(readFileSync(path, 'utf8'));
  for (const [key, value] of Object.entries(values)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return { path, loaded: true, values };
}

/**
 * Merges values into the config file and the live environment, writing to a
 * temporary file first so an interrupted save cannot truncate credentials.
 * An empty string removes the key.
 */
export function saveConfig(values, path = resolveConfigPath()) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });

  const existing = existsSync(path) ? parseEnv(readFileSync(path, 'utf8')) : {};
  const merged = { ...existing };
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) continue;
    if (value === '') delete merged[key];
    else merged[key] = String(value);
  }

  const text = Object.entries(merged)
    .map(([key, value]) => `${key}=${formatValue(value)}\n`)
    .join('');

  const staging = `${path}.tmp`;
  try {
    writeFileSync(staging, text, { mode: 0o600 });
    renameSync(staging, path);
    chmodSync(path, 0o600);
  } catch (err) {
    rmSync(staging, { force: true });
    throw err;
  }

  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) continue;
    if (value === '') delete process.env[key];
    else process.env[key] = String(value);
  }

  return path;
}

/** The SMTP keys the setup screen owns, in the order they are written. */
export function smtpFileValues({ host, port, user, pass, from }) {
  const values = {
    SMTP_HOST: host,
    SMTP_PORT: String(port),
    SMTP_USER: user,
    EMAIL_FROM: from,
  };
  // A blank password means "keep the one already saved".
  if (pass) values.SMTP_PASS = pass;
  return values;
}

export { KEYS };
