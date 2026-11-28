import { existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, sep } from 'node:path';
import {
  attachmentsFor,
  columnRoles,
  csvRowsToCsv,
  htmlToText,
  inlineForPreview,
  isSuppressed,
  linkWarnings,
  loadSuppressed,
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
import { intParam, paginate } from './index.mjs';
import { assetsDirFor, realRoot, rel, safePath } from './templates.mjs';

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
  return readdirSync(state.dataDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.csv'))
    .map((entry) => entry.name)
    .filter((name) => join(state.dataDir, name) !== state.suppressionPath)
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
    text: htmlToText(raw),
    bytes: Buffer.byteLength(raw, 'utf8'),
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
 * @param {{ path?: string | null, alreadySent?: Set<string>, suppressed?: Set<string>, q?: unknown, offset?: unknown, pageSize?: unknown }} [options]
 */
function rosterView(parsed, { path = null, alreadySent = new Set(), suppressed = new Set(), q = '', offset = 0, pageSize = 200 } = {}) {
  const roles = columnRoles(parsed.columns || []);
  const customColumns = roles.filter((c) => c.role === 'field').map((c) => c.name);
  const size = intParam(pageSize, 200, { min: 1, max: 1000 }) ?? 200;
  const indexed = parsed.recipients.map((rec, index) => ({ rec, index }));
  const page = paginate(indexed, {
    q: typeof q === 'string' ? q : '',
    limit: size,
    offset: intParam(offset, 0, { min: 0 }) ?? 0,
    match: ({ rec }, needle) => rec._email.toLowerCase().includes(needle)
      || rec._name.toLowerCase().includes(needle)
      || rec._company.toLowerCase().includes(needle)
      || customColumns.some((col) => String(rec[col] || '').toLowerCase().includes(needle)),
  });

  return {
    path,
    total: parsed.recipients.length,
    filtered: page.filtered,
    shown: page.items.length,
    offset: page.offset,
    pageSize: size,
    invalid: parsed.invalid,
    duplicates: parsed.duplicates,
    truncated: parsed.truncated,
    sentCount: parsed.recipients.filter((r) => alreadySent.has(r._email.toLowerCase())).length,
    suppressedCount: parsed.recipients.filter((r) => suppressed.has(r._email.toLowerCase())).length,
    columns: roles,
    recipients: page.items.map(({ rec, index }) => {
      const email = rec._email.toLowerCase();
      /** @type {Record<string, string>} */
      const fields = {};
      for (const col of customColumns) {
        if (rec[col]) fields[col] = rec[col];
      }
      return {
        index,
        email: rec._email,
        name: rec._name,
        company: rec._company,
        sent: alreadySent.has(email),
        suppressed: suppressed.has(email),
        fields,
      };
    }),
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
      const suppressed = loadSuppressed(state.suppressionPath);
      return json(200, rosterView(parsed, {
        path: rel(csvPath, state),
        alreadySent,
        suppressed,
        q: body.q,
        offset: body.offset,
        pageSize: body.pageSize,
      }));
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
      if (body.dryRun === true) {
        return json(200, rosterView(parsed, {
          suppressed: loadSuppressed(state.suppressionPath),
          q: body.q,
          offset: body.offset,
          pageSize: body.pageSize,
        }));
      }
      if (!parsed.recipients.length) return fail(400, 'No valid email addresses to save');

      const target = nextCsvPath(body.name || parsed.recipients[0]._email.replace(/@.*$/, '') + '-list', state);
      // Write then rename, so a crash cannot leave a half-written recipient file.
      const staging = `${target}.tmp`;
      try {
        const serialized = asCsv
          ? csvRowsToCsv(parsed.columns, parsed.recipients)
          : recipientsToCsv(parsed.recipients);
        writeFileSync(staging, serialized, 'utf8');
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
  {
    method: 'POST',
    path: '/api/csv/delete',
    handler: async ({ readJson, json, fail, state }) => {
      const body = await readJson();
      const rawPath = String(body.path ?? body.csv ?? '').trim();
      if (!rawPath) return fail(400, 'Missing file path');
      const csvPath = safePath(rawPath, state, { roots: [state.dataDir], ext: ['.csv'] });
      if (csvPath === realRoot(state.suppressionPath)) {
        return fail(400, 'Not allowed: cannot delete the suppression list');
      }
      rmSync(csvPath, { force: true });
      return json(200, { ok: true, deleted: rel(csvPath, state) });
    },
  },
];
