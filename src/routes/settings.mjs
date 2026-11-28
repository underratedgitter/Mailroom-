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
import { inspectSenderDns } from '../lib/dns.mjs';
import { errMsg } from '../lib/errors.mjs';
import { bareAddress, configIssue, publicUrlIssue, unsubscribeUrlIssue } from '../lib/mailer.mjs';
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
 * @returns {SmtpConfig & { maxPerHour: string, maxPerDomainPerHour: string, maxPerDay: string, publicUrl: string }}
 */
function smtpConfigFrom(body) {
  const current = resolveSmtpConfig();
  const host = String(body.host ?? current.host).trim();
  const port = Number(body.port ?? current.port);
  const secure = secureFrom(body.secure, port);
  const user = String(body.user ?? current.user).trim();
  const sameMailbox = host.toLowerCase() === current.host.toLowerCase() && user === current.user;
  const supplied = body.pass === undefined || body.pass === '' ? (sameMailbox ? current.pass : '') : String(body.pass);
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
    publicUrl: textSetting(body.publicUrl, current.publicUrl || '').replace(/\/+$/, ''),
    maxPerHour: textSetting(body.maxPerHour, process.env.MAX_PER_HOUR ?? ''),
    maxPerDomainPerHour: textSetting(body.maxPerDomainPerHour, process.env.MAX_PER_DOMAIN_PER_HOUR ?? ''),
    maxPerDay: textSetting(body.maxPerDay, process.env.MAX_PER_DAY ?? ''),
    isLocal,
    configured: Boolean((user && pass) || isLocal),
  };
}

/** @param {SmtpConfig} cfg */
function smtpConnectionIssue(cfg) {
  if (!cfg.host) return 'SMTP host is required';
  if (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535) {
    return 'SMTP port must be a whole number between 1 and 65535';
  }
  if (!cfg.isLocal && !cfg.user) return 'Mailbox address is required';
  if (!cfg.isLocal && !cfg.pass) return 'An SMTP password or app password is required';
  return null;
}

/**
 * Why the optional delivery settings cannot be saved, or null.
 * @param {SmtpConfig & { maxPerHour: string, maxPerDomainPerHour: string, maxPerDay: string, publicUrl: string }} cfg
 * @returns {string | null}
 */
function deliverySettingsIssue(cfg) {
  if (cfg.replyTo && !emailRe.test(bareAddress(cfg.replyTo))) {
    return 'Reply-To must be an email address such as help@example.com or Help <help@example.com>';
  }
  const urlIssue = unsubscribeUrlIssue(cfg.unsubscribeUrl) || publicUrlIssue(cfg.publicUrl);
  if (urlIssue) return urlIssue;
  try {
    rateLimitsFromEnv({
      MAX_PER_HOUR: cfg.maxPerHour,
      MAX_PER_DOMAIN_PER_HOUR: cfg.maxPerDomainPerHour,
      MAX_PER_DAY: cfg.maxPerDay,
    });
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
    publicUrl: cfg.publicUrl || '',
    maxPerHour: process.env.MAX_PER_HOUR ?? '',
    maxPerDomainPerHour: process.env.MAX_PER_DOMAIN_PER_HOUR ?? '',
    maxPerDay: process.env.MAX_PER_DAY ?? '',
    configured: cfg.configured,
    passwordSet: Boolean(cfg.pass),
    webhookConfigured: Boolean(String(process.env.MAILROOM_WEBHOOK_SECRET || '').trim()),
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
      const smtp = smtpState();
      return json(200, {
        ...smtp,
        configured: smtp.configured,
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
      const connectionIssue = smtpConnectionIssue(cfg);
      if (connectionIssue) return fail(400, connectionIssue);
      const mailer = createMailer(cfg);
      const result = await mailer.verify();
      mailer.close();
      return json(200, { ...result, smtp: { host: cfg.host, port: cfg.port, user: cfg.user, from: cfg.from } });
    },
  },
  {
    method: 'POST',
    path: '/api/settings/dns',
    handler: async ({ readJson, json, fail }) => {
      const body = await readJson();
      const current = resolveSmtpConfig();
      const from = String(body.from ?? current.from ?? '').trim();
      const selector = String(body.selector ?? process.env.DKIM_SELECTOR ?? '').trim();
      try {
        const report = await inspectSenderDns(from, { selector });
        return json(200, report);
      } catch (err) {
        return fail(400, errMsg(err));
      }
    },
  },
  {
    method: 'POST',
    path: '/api/settings',
    handler: async ({ readJson, json, fail, state }) => {
      const body = await readJson();
      const cfg = smtpConfigFrom(body);

      const connectionIssue = smtpConnectionIssue(cfg);
      if (connectionIssue) return fail(400, connectionIssue);
      // A relay on this machine needs no sign-in, only a From address to send as.
      if (!cfg.from) return fail(400, 'A From address is required');
      if (!cfg.configured) return fail(400, 'Those settings are incomplete');
      // Each value becomes one line of the config file; a line break would add keys.
      if ([cfg.host, cfg.user, cfg.from, cfg.replyTo, cfg.unsubscribeUrl, cfg.publicUrl, cfg.maxPerHour, cfg.maxPerDomainPerHour, cfg.maxPerDay].some((value) => /[\r\n\0]/.test(value))) {
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
