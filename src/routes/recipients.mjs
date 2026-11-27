import { existsSync, lstatSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, sep } from 'node:path';
import {
  attachmentsFor,
  columnRoles,
  inlineForPreview,
  isSuppressed,
  linkWarnings,
  parseRecipients,
  parseRecipientsText,
  readLog,
  recipientsFromFile,
  recipientsToCsv,
  render,
  renderSubject,
  resolveSmtpConfig,
  sentAddresses,
  templateVariables,
} from '../lib/core.mjs';
import { errMsg } from '../lib/errors.mjs';
import { unsubscribeLink } from '../lib/mailer.mjs';
import { assetsDirFor, rel, safePath } from './templates.mjs';

/** @typedef {import('./index.mjs').RouteDef} RouteDef */
/** @typedef {import('./index.mjs').ServerState} ServerState */
/** @typedef {import('../lib/core.mjs').Recipient} Recipient */
/** @typedef {import('../lib/core.mjs').ParsedRecipients} ParsedRecipients */
/**
 * @typedef {{
 *   csvPath: string | null,
 *   source: string,
 *   templatePath: string,
 *   assetsDir: string | null,
 *   subject: string,
 *   campaignId: string,
 *   parsed: ParsedRecipients,
 *   alreadySent: Set<string>,
 *   templateHtml: string,
 * }} ResolvedInput
 */

/** @param {ServerState} state */
export function listCsvs(state) {
  if (!existsSync(state.dataDir)) return [];
  return readdirSync(state.dataDir)
    .filter((name) => name.toLowerCase().endsWith('.csv'))
    .filter((name) => join(state.dataDir, name) !== state.suppressionPath)
    .filter((name) => !lstatSync(join(state.dataDir, name)).isSymbolicLink())
    .sort()
    .map((name) => {
      const path = join(state.dataDir, name);
      /** @type {{ path: string, name: string, recipients: number, invalid: number, duplicates: number, error: string | null }} */
      const item = { path: rel(path, state), name, recipients: 0, invalid: 0, duplicates: 0, error: null };
      try {
        const parsed = parseRecipients(readFileSync(path, 'utf8'));
        item.recipients = parsed.recipients.length;
        item.invalid = parsed.invalid;
        item.duplicates = parsed.duplicates;
      } catch (err) {
        item.error = errMsg(err);
      }
      return item;
    });
}

/**
 * Shared input resolution for preview / test / send / schedule.
 * @param {Record<string, unknown>} body
 * @param {ServerState} state
 * @returns {ResolvedInput}
 */
export function resolveInput(body, state) {
  const templatePath = safePath(body.html, state, { roots: [state.templateDir], ext: ['.html', '.htm'] });
  const assetsDir = assetsDirFor(templatePath, state);
  const subject = String(body.subject ?? '').trim();
  if (!subject) throw new Error('Subject is required');

  const limit = Number(body.limit);
  const options = { limit: Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : Infinity };

  // Recipients come either from a saved CSV or from the paste box.
  const raw = typeof body.raw === 'string' ? body.raw.trim() : '';
  const csvPath = raw ? null : safePath(body.csv, state, { roots: [state.dataDir], ext: ['.csv'] });
  const parsed = csvPath ? recipientsFromFile(csvPath, options) : parseRecipientsText(raw, options);
  if (!parsed.recipients.length) {
    throw new Error(raw ? 'No valid email addresses in the pasted list' : 'No valid email addresses found in this CSV');
  }

  const campaignId = String(body.campaign ?? '').trim();
  if (subject.length > 300) throw new Error('Subject is too long (300 characters max)');
  if (campaignId.length > 120) throw new Error('Campaign name is too long (120 characters max)');
  const alreadySent = sentAddresses(readLog(state.logPath), campaignId);

  return {
    csvPath,
    source: raw ? 'pasted' : String(csvPath),
    templatePath,
    assetsDir,
    subject,
    campaignId,
    parsed,
    alreadySent,
    templateHtml: readFileSync(templatePath, 'utf8'),
  };
}

/**
 * data/<slug>.csv, with a numeric suffix if that name is taken.
 * @param {unknown} name
 * @param {ServerState} state
 * @returns {string}
 */
function nextCsvPath(name, state) {
  const slug = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || `recipients-${Date.now()}`;
  let candidate = join(state.dataDir, `${slug.replace(/\.csv$/, '')}.csv`);
  let n = 2;
  // The suppression list lives in data/ too; a recipient list must never claim its name.
  while (existsSync(candidate) || candidate === state.suppressionPath) {
    candidate = join(state.dataDir, `${slug.replace(/\.csv$/, '')}-${n}.csv`);
    n++;
  }
  return candidate;
}

/**
 * Each {{field}} the message uses, and whether the recipient list can fill it.
 * @param {string} text
 * @param {{ name: string, role: string }[]} columns
 * @returns {{ name: string, status: string }[]}
 */
function placeholdersFor(text, columns) {
  const known = new Set(columns.map((c) => c.name));
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {{ name: string, status: string }[]} */
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

/**
 * Rendered message for one recipient, images inlined so a browser can show it.
 * @param {ResolvedInput} input
 * @param {ServerState} state
 * @param {unknown} [index]
 */
function previewFor(input, state, index = 0) {
  const i = Math.max(0, Math.min(input.parsed.recipients.length - 1, Number(index) || 0));
  const rec = input.parsed.recipients[i];
  /** @param {Recipient} r */
  const held = (r) => !input.alreadySent.has(r._email.toLowerCase()) && isSuppressed(state.suppressionPath, r._email);
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

/**
 * The recipient table the page shows for a saved CSV, a dry run or a pasted list.
 * @param {ParsedRecipients} parsed
 * @param {{ path?: string | null, alreadySent?: Set<string> }} [options]
 */
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

/** @type {RouteDef[]} */
export const routes = [
  {
    method: 'POST',
    path: '/api/preview',
    handler: async ({ readJson, json, state }) => {
      const body = await readJson();
      const input = resolveInput(body, state);
      return json(200, previewFor(input, state, body.index));
    },
  },
  {
    method: 'POST',
    path: '/api/roster',
    // Who is in a saved CSV — shown under the picker so the list is visible.
    handler: async ({ readJson, json, state }) => {
      const body = await readJson();
      const csvPath = safePath(body.csv, state, { roots: [state.dataDir], ext: ['.csv'] });
      const limit = Number(body.limit);
      const parsed = recipientsFromFile(csvPath, {
        limit: Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : Infinity,
      });
      const campaignId = String(body.campaign ?? '').trim();
      const alreadySent = sentAddresses(readLog(state.logPath), campaignId);
      return json(200, rosterView(parsed, { path: rel(csvPath, state), alreadySent }));
    },
  },
  {
    method: 'POST',
    path: '/api/recipients',
    // Save a pasted list as a CSV in data/ so it can be reused or edited.
    handler: async ({ readJson, json, fail, state }) => {
      const body = await readJson();
      const text = String(body.text ?? '').trim();
      // format "csv" keeps a header row and its extra columns for {{merge fields}};
      // anything else is the one-address-per-line paste format.
      const asCsv = body.format === 'csv';
      // A dry run reports what would be saved, so the page can validate as the
      // user types or picks a file, without leaving a file behind.
      if (body.dryRun === true && !text) {
        return json(200, rosterView({ recipients: [], total: 0, invalid: 0, duplicates: 0, truncated: 0, columns: [] }));
      }
      if (!text) return fail(400, 'Nothing to save');
      const parsed = asCsv ? parseRecipients(text) : parseRecipientsText(text);
      if (body.dryRun === true) return json(200, rosterView(parsed));
      if (!parsed.recipients.length) return fail(400, 'No valid email addresses to save');

      const target = nextCsvPath(body.name || parsed.recipients[0]._email.replace(/@.*$/, '') + '-list', state);
      // Write then rename, so a crash cannot leave a half-written recipient file.
      const staging = `${target}.tmp`;
      try {
        writeFileSync(staging, asCsv ? `${text}\n` : recipientsToCsv(parsed.recipients), 'utf8');
        renameSync(staging, target);
      } catch (err) {
        rmSync(staging, { force: true });
        throw err;
      }
      return json(201, {
        path: rel(target, state),
        name: target.split(sep).pop() || basename(target),
        recipients: parsed.recipients.length,
        duplicates: parsed.duplicates,
        invalid: parsed.invalid,
      });
    },
  },
];
