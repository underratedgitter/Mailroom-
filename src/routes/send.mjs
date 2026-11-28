import { randomUUID } from 'node:crypto';
import {
  countAlreadySent,
  createMailer,
  emailRe,
  isSuppressed,
  render,
  renderSubject,
  resolveSmtpConfig,
  runCampaign,
} from '../lib/core.mjs';
import { conflict, errMsg, errStatus, httpError } from '../lib/errors.mjs';
import { resolveInput } from './recipients.mjs';
import { complianceIssue, smtpState } from './settings.mjs';

/** @typedef {import('node:http').ServerResponse} ServerResponse */
/** @typedef {import('./index.mjs').RouteDef} RouteDef */
/** @typedef {import('./index.mjs').ServerState} ServerState */
/** @typedef {import('../lib/core.mjs').Recipient} Recipient */
/** @typedef {import('../lib/core.mjs').CampaignEvent} CampaignEvent */
/** @typedef {{ sent: number, failed: number, skipped: number, failures: unknown[], stopped: boolean, error?: string, remaining?: number, total?: number, logPath?: string | null, suppressed?: number, uncertain?: unknown[] }} JobSummary */
/**
 * @typedef {CampaignEvent
 *   | { type: 'start', total: number, skipped: number, delay: number, campaign: string | null }
 *   | { type: 'error', error: string }
 *   | { type: 'done', summary: JobSummary }} JobEvent
 */
/**
 * @typedef {{
 *   id: string,
 *   events: JobEvent[],
 *   clients: Set<ServerResponse>,
 *   cancelled: boolean,
 *   done: boolean,
 *   summary: JobSummary | null,
 *   startedAt: string,
 *   scheduleId?: string,
 *   finished: Promise<unknown>,
 *   resolveFinished: (value: unknown) => void,
 * }} CampaignJob
 */
/**
 * @typedef {{
 *   parsed: { recipients: Recipient[] },
 *   templateHtml: string,
 *   subject: string,
 *   assetsDir: string | null,
 *   campaignId: string,
 *   alreadySent: Set<string>,
 * }} StartCampaignInput
 */

/**
 * Gap between messages, in ms. 4 s is the CLI and UI default and keeps a
 * single mailbox inside provider rate limits; an explicit 0 is honoured but a
 * missing or nonsense value must never become an unthrottled blast.
 * @param {unknown} value
 * @param {number} [fallback]
 * @returns {number}
 */
export function delayFrom(value, fallback = 4000) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(10 * 60 * 1000, Math.floor(n)));
}

/** @type {Map<string, CampaignJob>} */
const jobs = new Map();
/** @type {string | null} */
let activeJobId = null;

export function runningJob() {
  const job = activeJobId ? jobs.get(activeJobId) : null;
  return job && !job.done ? job : null;
}

/**
 * @param {ServerState} state
 * @returns {CampaignJob}
 */
function createJob(state) {
  if (state.isShuttingDown()) {
    throw httpError(503, 'Mailroom is shutting down');
  }
  // One campaign at a time: two runs would double-send whatever they share.
  if (runningJob()) {
    throw conflict('A campaign is already running — wait for it to finish');
  }

  /** @type {(value: unknown) => void} */
  let resolveFinished = () => {};
  const finished = new Promise((resolveDone) => { resolveFinished = resolveDone; });
  /** @type {CampaignJob} */
  const job = {
    id: randomUUID(),
    events: [],
    clients: new Set(),
    cancelled: false,
    done: false,
    summary: null,
    startedAt: new Date().toISOString(),
    finished,
    resolveFinished,
  };
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

/**
 * @param {CampaignJob} job
 * @param {JobEvent} event
 */
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
    job.resolveFinished(event.summary);
    if (activeJobId === job.id) activeJobId = null;
  }
}

/**
 * Runs a campaign in the background and streams progress through a job.
 * Used by POST /api/send and by the scheduler.
 * @param {StartCampaignInput} input
 * @param {ServerState} state
 * @param {{ delay?: number }} [options]
 * @returns {CampaignJob}
 */
export function startCampaign(input, state, { delay = 0 } = {}) {
  const cfg = resolveSmtpConfig();
  const job = createJob(state);

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
        suppressionPath: state.suppressionPath,
        delayMs: delay,
        mailer,
        logPath: state.logPath,
        shouldStop: () => job.cancelled,
        onEvent: (event) => emit(job, event),
      });
    } catch (err) {
      const message = errMsg(err);
      emit(job, { type: 'error', error: message });
      emit(job, { type: 'done', summary: { sent: 0, failed: 0, skipped: 0, failures: [], stopped: true, error: message } });
    } finally {
      mailer.close();
    }
  })();

  return job;
}

/** @type {RouteDef[]} */
export const routes = [
  {
    method: 'POST',
    path: '/api/verify',
    handler: async ({ json }) => {
      const cfg = resolveSmtpConfig();
      if (!cfg.configured) {
        return json(200, { ok: false, error: 'SMTP credentials are not set', smtp: smtpState() });
      }
      const mailer = createMailer(cfg);
      const result = await mailer.verify();
      mailer.close();
      return json(200, { ...result, smtp: smtpState() });
    },
  },
  {
    method: 'POST',
    path: '/api/test',
    handler: async ({ readJson, json, fail, state }) => {
      if (runningJob()) return fail(409, 'A campaign is running — send the test when it finishes');
      const body = await readJson();
      const input = resolveInput(body, state);
      const to = String(body.to || '').trim();
      if (!emailRe.test(to)) return fail(400, 'Enter a valid test address');
      if (isSuppressed(state.suppressionPath, to)) return fail(400, `${to} is on the suppression list`);
      const cfg = resolveSmtpConfig();
      if (!cfg.configured) return fail(400, 'SMTP credentials are not set');
      const issue = complianceIssue(cfg);
      if (issue) return fail(400, issue);

      const idx = Math.max(0, Math.min(input.parsed.recipients.length - 1, Number(body.index) || 0));
      const rec = { ...input.parsed.recipients[idx], _email: to };
      const mailer = createMailer(cfg);
      const verify = await mailer.verify();
      if (!verify.ok) {
        mailer.close();
        return json(200, { ok: false, error: verify.error });
      }
      const result = await mailer.send({
        to,
        subject: renderSubject(input.subject, rec),
        html: render(input.templateHtml, rec, cfg),
        assetsDir: input.assetsDir,
      });
      mailer.close();
      return json(200, {
        ok: result.success,
        error: result.success ? null : result.error,
        messageId: result.success ? result.messageId : null,
        inline: result.success ? result.inline : 0,
        from: cfg.from,
      });
    },
  },
  {
    method: 'POST',
    path: '/api/send',
    handler: async ({ readJson, json, fail, state }) => {
      const body = await readJson();
      if (body.confirm !== true) return fail(400, 'Send was not confirmed');
      const input = resolveInput(body, state);
      const cfg = resolveSmtpConfig();
      if (!cfg.configured) return fail(400, 'SMTP credentials are not set');
      const issue = complianceIssue(cfg);
      if (issue) return fail(400, issue);

      const delay = delayFrom(body.delay);
      let job;
      try {
        job = startCampaign(input, state, { delay });
      } catch (err) {
        return fail(resStatus(err), errMsg(err));
      }
      return json(202, {
        jobId: job.id,
        total: input.parsed.recipients.length,
        skipped: countAlreadySent(input.parsed.recipients, input.alreadySent),
      });
    },
  },
  {
    // Lets a reloaded page re-attach to a campaign that is still sending.
    method: 'GET',
    path: '/api/jobs/active',
    handler: ({ json }) => {
      const job = runningJob();
      if (!job) return json(200, { jobId: null });
      const start = job.events.find((event) => event.type === 'start');
      return json(200, {
        jobId: job.id,
        total: start && 'total' in start ? start.total : null,
        campaign: start && 'campaign' in start ? start.campaign : null,
        startedAt: job.startedAt,
        cancelled: job.cancelled,
      });
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/jobs\/([\w-]+)\/events$/,
    handler: ({ req, res, match, fail }) => {
      const job = match ? jobs.get(match[1]) : null;
      if (!job) return fail(404, 'Unknown job');

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
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/jobs\/([\w-]+)\/cancel$/,
    handler: ({ match, json, fail }) => {
      const job = match ? jobs.get(match[1]) : null;
      if (!job) return fail(404, 'Unknown job');
      job.cancelled = true;
      return json(200, { ok: true });
    },
  },
];

/** @param {unknown} err */
function resStatus(err) {
  return errStatus(err) || 409;
}
