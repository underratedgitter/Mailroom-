import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { countAlreadySent, readLog, resolveSmtpConfig, sentAddresses } from '../lib/core.mjs';
import { errMsg } from '../lib/errors.mjs';
import { resolveInput } from './recipients.mjs';
import { delayFrom, runningJob, startCampaign } from './send.mjs';
import { complianceIssue } from './settings.mjs';
import { assetsDirFor, rel, safePath } from './templates.mjs';

/** @typedef {import('./index.mjs').RouteDef} RouteDef */
/** @typedef {import('./index.mjs').ServerState} ServerState */
/** @typedef {import('../lib/core.mjs').Recipient} Recipient */
/** @typedef {import('./send.mjs').JobSummary} JobSummary */
/** @typedef {{ email: string, name: string, company: string, fields: Record<string, string> }} ScheduledRecipient */
/**
 * @typedef {{
 *   id: string,
 *   at: string,
 *   createdAt?: string,
 *   campaign: string,
 *   subject: string,
 *   template: string,
 *   templateHash?: string,
 *   delay: number,
 *   recipients: ScheduledRecipient[],
 *   status: string,
 *   interrupted?: boolean,
 *   error: string | null,
 *   result: { sent: number, failed: number, skipped: number, uncertain?: number } | null,
 * }} ScheduleEntry
 */

// ── Scheduled campaigns ──────────────────────────────────────────────
// The queue lives in a JSON file next to the send log, so a restart keeps it.
// Each entry stores its recipients at the moment it was scheduled: editing a
// CSV later cannot change what a queued send will do.
/**
 * @param {ServerState} state
 * @returns {ScheduleEntry[]}
 */
function readSchedule(state) {
  if (!existsSync(state.schedulePath)) return [];
  try {
    const parsed = JSON.parse(readFileSync(state.schedulePath, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error('[schedule] unreadable file:', errMsg(err));
    return [];
  }
}

/**
 * @param {ScheduleEntry[]} entries
 * @param {ServerState} state
 */
function writeSchedule(entries, state) {
  const staging = `${state.schedulePath}.tmp`;
  try {
    writeFileSync(staging, JSON.stringify(entries, null, 2));
    renameSync(staging, state.schedulePath);
  } catch (err) {
    rmSync(staging, { force: true });
    throw err;
  }
}

/** @param {ServerState} state */
function scheduleView(state) {
  return readSchedule(state)
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

/** @param {string} text */
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/**
 * @param {ScheduleEntry} entry
 * @param {ServerState} state
 */
function templateFor(entry, state) {
  const path = safePath(entry.template, state, { roots: [state.templateDir], ext: ['.html', '.htm'] });
  const html = readFileSync(path, 'utf8');
  // The recipients and subject were fixed when this was scheduled; so was what
  // the person approved in the preview. Entries from before the hash existed
  // have nothing to compare with.
  if (entry.templateHash && sha256(html) !== entry.templateHash) {
    throw new Error(`Template changed since scheduling: ${entry.template} is no longer what was approved. Check it, then schedule the campaign again.`);
  }
  return { path, html, assetsDir: assetsDirFor(path, state) };
}

/**
 * Runs one due entry; the caller has already marked it "sending".
 * @param {ScheduleEntry} entry
 * @param {ServerState} state
 */
async function fireScheduled(entry, state) {
  // Set again below if this run is cut short too.
  entry.interrupted = false;
  try {
    const template = templateFor(entry, state);
    const campaignId = String(entry.campaign || '');
    /** @type {Recipient[]} */
    const recipients = (entry.recipients || []).map((r) => ({
      ...r.fields,
      _email: r.email,
      _name: r.name || '',
      _company: r.company || '',
    }));
    if (!recipients.length) throw new Error('The scheduled list has no recipients');

    const job = startCampaign({
      parsed: { recipients },
      templateHtml: template.html,
      assetsDir: template.assetsDir,
      subject: entry.subject,
      campaignId,
      alreadySent: sentAddresses(readLog(state.logPath), campaignId),
    }, state, { delay: delayFrom(entry.delay) });
    job.scheduleId = entry.id;

    const summary = /** @type {JobSummary | null} */ (await job.finished);
    entry.result = {
      sent: summary?.sent || 0,
      failed: summary?.failed || 0,
      skipped: summary?.skipped || 0,
      ...(summary?.uncertain?.length ? { uncertain: summary.uncertain.length } : {}),
    };
    const stopping = state.isShuttingDown();
    if (job.cancelled && (summary?.remaining || 0) > 0) {
      // Stopped part-way. A shutdown puts the entry back in line so the next
      // start resumes it (the log skips whoever was already mailed); a person
      // pressing Stop means it is over.
      entry.status = stopping ? 'pending' : 'cancelled';
      if (stopping) {
        entry.result = null;
        entry.interrupted = true;
      }
    } else {
      entry.status = summary?.error || (!summary?.sent && summary?.failed) ? 'failed' : 'sent';
    }
    if (summary?.error) entry.error = summary.error;
  } catch (err) {
    entry.status = 'failed';
    entry.error = errMsg(err);
  } finally {
    // A send can run for hours, during which schedules are added and
    // cancelled. Write this entry's outcome into the file as it is now rather
    // than overwriting it with the copy read before the send began.
    const current = readSchedule(state);
    const stored = current.find((e) => e.id === entry.id);
    if (stored) {
      stored.status = entry.status;
      if (entry.interrupted) stored.interrupted = true;
      else delete stored.interrupted;
      stored.error = entry.error ?? null;
      stored.result = entry.result ?? null;
      writeSchedule(current, state);
    }
  }
}

/** @type {ReturnType<typeof setInterval> | null} */
let schedulerTimer = null;
let ticking = false;

export const isTicking = () => ticking;

/** @param {ServerState} state */
async function tick(state) {
  if (ticking || state.isShuttingDown()) return;
  ticking = true;
  try {
    const list = readSchedule(state);
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
      if (entry.status === 'pending' && !entry.interrupted && Date.parse(entry.at) < now - state.graceMs) {
        entry.status = 'missed';
        entry.error = 'The server was not running at the scheduled time';
        changed = true;
      }
    }
    if (changed) writeSchedule(list, state);

    if (runningJob()) return;
    const due = list.find((entry) => entry.status === 'pending' && Date.parse(entry.at) <= Date.now());
    if (!due) return;

    due.status = 'sending';
    writeSchedule(list, state);
    await fireScheduled(due, state);
  } catch (err) {
    console.error('[schedule] tick failed:', errMsg(err));
  } finally {
    ticking = false;
  }
}

/**
 * A crash or restart can leave an entry marked "sending" with no job behind
 * it. Nothing is running this early in the process, so put it back in line,
 * flagged as interrupted so it resumes whatever the grace window says.
 * @param {ServerState} state
 */
function recoverSchedule(state) {
  const list = readSchedule(state);
  let changed = false;
  for (const entry of list) {
    if (entry.status !== 'sending') continue;
    entry.status = 'pending';
    entry.interrupted = true;
    entry.error = null;
    changed = true;
  }
  if (changed) writeSchedule(list, state);
}

/** Starts the queue timer; safe to call twice. @param {ServerState} state */
export function startScheduler(state) {
  if (schedulerTimer) return;
  recoverSchedule(state);
  schedulerTimer = setInterval(() => { tick(state).catch(() => {}); }, Math.max(100, state.tickMs));
  setTimeout(() => tick(state).catch(() => {}), 250).unref();
  return schedulerTimer;
}

export function stopScheduler() {
  if (schedulerTimer) clearInterval(schedulerTimer);
}

/** @type {RouteDef[]} */
export const routes = [
  {
    method: 'GET',
    path: '/api/schedule',
    handler: ({ json, state }) => json(200, {
      entries: scheduleView(state),
      now: new Date().toISOString(),
      graceMs: state.graceMs,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    }),
  },
  {
    method: 'POST',
    path: '/api/schedule',
    handler: async ({ readJson, json, fail, state }) => {
      const body = await readJson();
      const input = resolveInput(body, state);
      // Queueing before SMTP is set up is allowed; the run re-checks when it fires.
      const smtp = resolveSmtpConfig();
      const issue = smtp.configured ? complianceIssue(smtp) : null;
      if (issue) return fail(400, issue);

      const at = Date.parse(String(body.at || ''));
      if (!Number.isFinite(at)) return fail(400, 'Pick a date and time');
      if (at < Date.now() + 1000) return fail(400, 'Pick a time in the future');

      const list = readSchedule(state);
      const active = list.filter((e) => e.status === 'pending' || e.status === 'sending').length;
      if (active >= 100) return fail(400, 'Too many scheduled campaigns — finish or cancel some first');

      /** @type {ScheduleEntry} */
      const entry = {
        id: randomUUID(),
        at: new Date(at).toISOString(),
        createdAt: new Date().toISOString(),
        campaign: input.campaignId,
        subject: input.subject,
        template: rel(input.templatePath, state),
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
      writeSchedule(list, state);

      return json(201, {
        entry: scheduleView(state).find((e) => e.id === entry.id),
        total: entry.recipients.length,
        skipped: countAlreadySent(input.parsed.recipients, input.alreadySent),
      });
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/schedule\/([\w-]+)\/(cancel|run)$/,
    handler: ({ match, json, fail, state }) => {
      const list = readSchedule(state);
      const entry = match ? list.find((e) => e.id === match[1]) : null;
      if (!entry || !match) return fail(404, 'Unknown scheduled campaign');

      if (match[2] === 'cancel') {
        if (entry.status !== 'pending' && entry.status !== 'missed') {
          return fail(409, `Cannot cancel a campaign that is ${entry.status}`);
        }
        entry.status = 'cancelled';
        writeSchedule(list, state);
        return json(200, { ok: true });
      }

      if (entry.status === 'sending') return fail(409, 'That campaign is sending already');
      if (runningJob()) return fail(409, 'A campaign is already running');
      entry.at = new Date().toISOString();
      entry.status = 'pending';
      writeSchedule(list, state);
      tick(state).catch(() => {});
      return json(202, { ok: true });
    },
  },
];
