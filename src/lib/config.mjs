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
  statSync,
  accessSync,
  constants,
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

/**
 * The keys the setup screen owns, in the order they are written. An optional
 * key that is undefined is left as it is; an empty string removes it.
 */
export function smtpFileValues({ host, port, secure, user, pass, from, replyTo, unsubscribeUrl, maxPerHour }) {
  const values = {
    SMTP_HOST: host,
    SMTP_PORT: String(port),
    SMTP_SECURE: secure === undefined ? undefined : String(secure),
    SMTP_USER: user,
    EMAIL_FROM: from,
    EMAIL_REPLY_TO: replyTo,
    UNSUBSCRIBE_URL: unsubscribeUrl,
    MAX_PER_HOUR: maxPerHour,
  };
  // A blank password means "keep the one already saved".
  if (pass) values.SMTP_PASS = pass;
  return values;
}

// ── Startup validation ───────────────────────────────────────────────
// A typo in an environment variable should stop the process with a sentence
// naming the variable, not surface later as NaN or a stack trace.
const isWhole = (text) => /^\d+$/.test(text);

function portProblem(env, name, min, hint = '') {
  const value = env[name];
  if (value === undefined || value === '') return null;
  const text = String(value).trim();
  if (isWhole(text) && Number(text) >= min && Number(text) <= 65535) return null;
  return `${name} must be a whole number from ${min} to 65535, got "${value}"${hint}`;
}

function wholeProblem(env, name, min) {
  const value = env[name];
  if (value === undefined || value === '') return null;
  if (isWhole(String(value).trim()) && Number(value) >= min) return null;
  return `${name} must be a whole number of at least ${min}, got "${value}"`;
}

/** Problems with the SMTP variables alone (what the CLI needs). */
export function smtpProblems(env = process.env) {
  const problems = [portProblem(env, 'SMTP_PORT', 1)];
  const secure = env.SMTP_SECURE;
  if (secure !== undefined && secure !== '' && secure !== 'true' && secure !== 'false') {
    problems.push(`SMTP_SECURE must be "true" or "false", got "${secure}"`);
  }
  return problems.filter(Boolean);
}

function templatesProblem(dir) {
  let info;
  try {
    info = statSync(dir);
  } catch (err) {
    return err.code === 'ENOENT' || err.code === 'ENOTDIR'
      ? `Templates folder not found: ${dir}`
      : `Cannot read the templates folder ${dir}: ${err.message}`;
  }
  if (!info.isDirectory()) return `Templates folder ${dir} is not a folder`;
  try {
    accessSync(dir, constants.R_OK | constants.X_OK);
  } catch (err) {
    return `Cannot read the templates folder ${dir}: ${err.message}`;
  }
  return null;
}

function writableProblem({ label, path }) {
  try {
    mkdirSync(path, { recursive: true });
    accessSync(path, constants.W_OK);
    return null;
  } catch (err) {
    return `Cannot use the ${label} ${path}: ${err.message}`;
  }
}

/**
 * Everything wrong with the server's configuration, in one list so a
 * misconfigured install is fixed in one pass. `writableDirs` are created if
 * missing.
 */
export function configProblems(env = process.env, { templatesDir, writableDirs = [] } = {}) {
  const problems = [
    portProblem(env, 'GUI_PORT', 0, ' (set it with --port or GUI_PORT)'),
    ...smtpProblems(env),
    wholeProblem(env, 'SCHEDULE_GRACE_MS', 0),
    wholeProblem(env, 'SCHEDULER_INTERVAL_MS', 1),
    wholeProblem(env, 'SEND_LOG_MAX_BYTES', 0),
    wholeProblem(env, 'SEND_LOG_KEEP', 1),
  ];
  if (templatesDir) problems.push(templatesProblem(templatesDir));
  for (const dir of writableDirs) problems.push(writableProblem(dir));
  return problems.filter(Boolean);
}

/** Throws one Error listing every problem; returns quietly when there are none. */
export function assertConfig(env = process.env, options = {}) {
  const problems = configProblems(env, options);
  if (!problems.length) return;
  throw new Error(`Invalid configuration:\n    - ${problems.join('\n    - ')}`);
}

export { KEYS };
