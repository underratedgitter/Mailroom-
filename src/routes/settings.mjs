import { saveConfig, smtpFileValues } from '../lib/config.mjs';
import {
  campaignSummaries,
  createMailer,
  emailRe,
  loadSuppressed,
  rateLimitsFromEnv,
  readLog,
  resolveSmtpConfig,
} from '../lib/core.mjs';
import { errMsg } from '../lib/errors.mjs';
import { bareAddress, configIssue, unsubscribeUrlIssue } from '../lib/mailer.mjs';
import { listCsvs } from './recipients.mjs';
import { listTemplates, rel } from './templates.mjs';

/** @typedef {import('./index.mjs').RouteDef} RouteDef */
/** @typedef {import('../lib/mailer.mjs').SmtpConfig} SmtpConfig */

/**
 * true is implicit TLS, false is STARTTLS; unspecified follows the saved mode, else the port.
 * @param {unknown} value
 * @param {number} port
 * @returns {boolean}
 */
function secureFrom(value, port) {
  if (value === undefined) return resolveSmtpConfig({ ...process.env, SMTP_PORT: String(port) }).secure;
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === 'false') return value === 'true';
  throw new Error('Invalid TLS mode: secure must be true (implicit TLS) or false (STARTTLS)');
}

/**
 * A text setting from the form: not sent keeps what is saved, empty clears it.
 * @param {unknown} value
 * @param {string} saved
 * @returns {string}
 */
const textSetting = (value, saved) => (value === undefined ? saved : String(value ?? '').trim());

/**
 * SMTP settings from a settings form, falling back to what is saved.
 * @param {Record<string, unknown>} body
 * @returns {SmtpConfig & { maxPerHour: string }}
 */
function smtpConfigFrom(body) {
  const current = resolveSmtpConfig();
  const host = String(body.host ?? current.host).trim();
  const port = Number(body.port ?? current.port) || 465;
  const secure = secureFrom(body.secure, port);
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
    replyTo: textSetting(body.replyTo, current.replyTo),
    unsubscribeMailto: current.unsubscribeMailto,
    unsubscribeUrl: textSetting(body.unsubscribeUrl, current.unsubscribeUrl),
    maxPerHour: textSetting(body.maxPerHour, process.env.MAX_PER_HOUR ?? ''),
    isLocal,
    configured: Boolean((user && pass) || isLocal),
  };
}

/**
 * Why the optional delivery settings cannot be saved, or null.
 * @param {SmtpConfig & { maxPerHour: string }} cfg
 * @returns {string | null}
 */
function deliverySettingsIssue(cfg) {
  if (cfg.replyTo && !emailRe.test(bareAddress(cfg.replyTo))) {
    return 'Reply-To must be an email address such as help@example.com or Help <help@example.com>';
  }
  const url = unsubscribeUrlIssue(cfg.unsubscribeUrl);
  if (url) return url;
  try {
    rateLimitsFromEnv({ MAX_PER_HOUR: cfg.maxPerHour });
  } catch (err) {
    return errMsg(err);
  }
  return null;
}

export function smtpState() {
  const cfg = resolveSmtpConfig();
  return {
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    user: cfg.user,
    from: cfg.from,
    replyTo: cfg.replyTo,
    unsubscribeUrl: cfg.unsubscribeUrl,
    maxPerHour: process.env.MAX_PER_HOUR ?? '',
    configured: cfg.configured,
    passwordSet: Boolean(cfg.pass),
  };
}

/**
 * Why a send cannot go out compliantly (bad ceiling, From or unsubscribe URL), or null.
 * @param {SmtpConfig} cfg
 * @returns {string | null}
 */
export function complianceIssue(cfg) {
  try {
    rateLimitsFromEnv();
  } catch (err) {
    return errMsg(err);
  }
  return configIssue(cfg);
}

function suggestedCampaign() {
  const stamp = new Date().toISOString().slice(0, 7);
  return `campaign-${stamp}`;
}

/** @type {RouteDef[]} */
export const routes = [
  {
    method: 'GET',
    path: '/api/state',
    handler: ({ json, state }) => {
      const entries = readLog(state.logPath);
      const cfg = resolveSmtpConfig();
      return json(200, {
        app: { name: 'Mailroom', version: state.appVersion },
        smtp: smtpState(),
        setup: {
          configured: cfg.configured,
          configPath: rel(state.configFilePath, state),
          authRequired: state.authOn,
        },
        csvs: listCsvs(state),
        templates: listTemplates(state),
        log: {
          path: rel(state.logPath, state),
          entries: entries.length,
          campaigns: campaignSummaries(entries).slice(0, 12),
        },
        suppression: { path: rel(state.suppressionPath, state), count: loadSuppressed(state.suppressionPath).size },
        defaults: { delay: 4000, campaign: suggestedCampaign() },
        platform: process.platform,
      });
    },
  },
  {
    method: 'GET',
    path: '/api/settings',
    handler: ({ json, state }) => {
      const cfg = resolveSmtpConfig();
      return json(200, {
        host: cfg.host,
        port: cfg.port,
        secure: cfg.secure,
        user: cfg.user,
        from: cfg.from,
        replyTo: cfg.replyTo,
        unsubscribeUrl: cfg.unsubscribeUrl,
        maxPerHour: process.env.MAX_PER_HOUR ?? '',
        passwordSet: Boolean(cfg.pass),
        configured: cfg.configured,
        configPath: rel(state.configFilePath, state),
        authRequired: state.authOn,
      });
    },
  },
  {
    method: 'POST',
    path: '/api/settings/test',
    handler: async ({ readJson, json, fail }) => {
      const body = await readJson();
      const cfg = smtpConfigFrom(body);
      if (!cfg.configured) return fail(400, 'Fill in the server and the mailbox first');
      const mailer = createMailer(cfg);
      const result = await mailer.verify();
      mailer.close();
      return json(200, { ...result, smtp: { host: cfg.host, port: cfg.port, user: cfg.user, from: cfg.from } });
    },
  },
  {
    method: 'POST',
    path: '/api/settings',
    handler: async ({ readJson, json, fail, state }) => {
      const body = await readJson();
      const cfg = smtpConfigFrom(body);

      if (!cfg.host) return fail(400, 'SMTP host is required');
      // A relay on this machine needs no sign-in, only a From address to send as.
      if (!cfg.isLocal && !cfg.user) return fail(400, 'Mailbox address is required');
      if (!cfg.isLocal && !cfg.pass) return fail(400, 'An app password is required');
      if (!cfg.from) return fail(400, 'A From address is required');
      if (!cfg.configured) return fail(400, 'Those settings are incomplete');
      // Each value becomes one line of the config file; a line break would add keys.
      if ([cfg.host, cfg.user, cfg.from, cfg.replyTo, cfg.unsubscribeUrl, cfg.maxPerHour].some((value) => /[\r\n\0]/.test(value))) {
        return fail(400, 'Settings cannot contain line breaks');
      }
      const delivery = deliverySettingsIssue(cfg);
      if (delivery) return fail(400, delivery);

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
        return json(200, { ok: false, saved: false, error: verifyError || 'Could not sign in to the mail server' });
      }

      saveConfig(smtpFileValues(cfg), state.configFilePath);
      return json(200, { ok: true, saved: true, verified, smtp: smtpState() });
    },
  },
];
