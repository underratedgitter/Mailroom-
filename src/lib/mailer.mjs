// SMTP configuration and the headers every message carries.
//
// EMAIL_FROM is preferred, then SMTP_FROM, then the authenticated account.
// Port 465 is implicit TLS; 587 and 25 require STARTTLS. A local MTA on
// localhost needs no credentials.
//
// Bulk-sender headers (Gmail/Yahoo rules, RFC 8058):
//   EMAIL_REPLY_TO       Reply-To address; also the default unsubscribe mailbox
//   UNSUBSCRIBE_MAILTO   unsubscribe mailbox if it should differ from the above
//                        (default: Reply-To, else the From address)
//   UNSUBSCRIBE_URL      https:// endpoint you host that accepts a one-click
//                        POST; {email} is replaced with the recipient

import { randomUUID } from 'node:crypto';

/**
 * @typedef {{
 *   host: string,
 *   port: number,
 *   secure: boolean,
 *   requireTLS: boolean,
 *   user: string,
 *   pass: string,
 *   from: string,
 *   replyTo: string,
 *   unsubscribeMailto?: string,
 *   unsubscribeUrl: string,
 *   isLocal: boolean,
 *   configured: boolean,
 *   socketTimeout?: number,
 *   maxPerHour?: string,
 * }} SmtpConfig
 */

/** @typedef {{ 'List-Unsubscribe'?: string, 'List-Unsubscribe-Post'?: string }} MailHeaders */
/** @typedef {{ messageId: string, date: Date, replyTo?: string, headers: MailHeaders }} BulkFields */

/**
 * `Desk <desk@example.com>` -> `desk@example.com`.
 * @param {unknown} value
 * @returns {string}
 */
export function bareAddress(value) {
  const text = String(value ?? '').trim();
  const angled = text.match(/<([^<>]+)>\s*$/);
  return (angled ? angled[1] : text).trim();
}

/**
 * The part after the last at-sign, lower-cased; empty when there is none.
 * @param {unknown} value
 * @returns {string}
 */
export function addressDomain(value) {
  const address = bareAddress(value);
  const at = address.lastIndexOf('@');
  return at > 0 ? address.slice(at + 1).toLowerCase() : '';
}

/**
 * The settings a send still needs; a local relay needs none.
 * @param {SmtpConfig} cfg
 * @returns {string[]}
 */
export function missingSmtpFields(cfg) {
  if (cfg.isLocal) return [];
  /** @type {string[]} */
  const missing = [];
  if (!cfg.user) missing.push('SMTP_USER');
  if (!cfg.pass) missing.push('SMTP_PASS');
  return missing;
}

/**
 * @param {Record<string, string | undefined>} [env]
 * @returns {SmtpConfig}
 */
export function resolveSmtpConfig(env = process.env) {
  const user = (env.SMTP_USER || env.GMAIL_USER || '').trim();
  // Strip internal/surrounding whitespace (Google shows App Passwords in
  // 4-character groups, which are easy to paste with spaces).
  const pass = (env.SMTP_PASS || env.GMAIL_PASS || '').replace(/\s+/g, '');
  const host = env.SMTP_HOST || 'smtp.gmail.com';
  const port = parseInt(env.SMTP_PORT || '465', 10);

  const secure = env.SMTP_SECURE ? env.SMTP_SECURE === 'true' : port === 465;
  const isLocal = host === 'localhost' || host === '127.0.0.1';
  const requireTLS = !secure && !isLocal;
  const from = env.EMAIL_FROM || env.SMTP_FROM || user;
  const replyTo = (env.EMAIL_REPLY_TO || '').trim();

  return {
    host,
    port,
    secure,
    requireTLS,
    user,
    pass,
    from,
    replyTo,
    unsubscribeMailto: (env.UNSUBSCRIBE_MAILTO || '').trim(),
    unsubscribeUrl: (env.UNSUBSCRIBE_URL || '').trim(),
    isLocal,
    configured: Boolean((user && pass) || isLocal),
  };
}

/**
 * Why an UNSUBSCRIBE_URL cannot be used, or null (empty means none).
 * @param {string} url
 * @returns {string | null}
 */
export function unsubscribeUrlIssue(url) {
  if (url && !/^https:\/\/[^\s<>]+$/i.test(url)) {
    return 'UNSUBSCRIBE_URL must be an https:// URL with no spaces (RFC 8058 one-click needs HTTPS).';
  }
  return null;
}

/**
 * Why this configuration cannot send compliant mail, or null when it can.
 * @param {SmtpConfig} cfg
 * @returns {string | null}
 */
export function configIssue(cfg) {
  if (!addressDomain(cfg.from)) {
    return 'EMAIL_FROM must be a full address such as news@example.com: Message-ID and unsubscribe headers are built from its domain.';
  }
  return unsubscribeUrlIssue(cfg.unsubscribeUrl);
}

/**
 * `mailto:` link to the unsubscribe mailbox (UNSUBSCRIBE_MAILTO, else Reply-To, else From), or ''.
 * @param {SmtpConfig} cfg
 * @returns {string}
 */
function unsubscribeMailtoLink(cfg) {
  const mailbox = bareAddress(cfg.unsubscribeMailto || cfg.replyTo || cfg.from);
  if (!mailbox) return '';
  const at = mailbox.lastIndexOf('@');
  return `mailto:${encodeURIComponent(mailbox.slice(0, at))}${mailbox.slice(at)}?subject=unsubscribe`;
}

/**
 * @param {SmtpConfig} cfg
 * @param {string} to
 * @returns {string}
 */
const unsubscribeUrlFor = (cfg, to) => cfg.unsubscribeUrl.replaceAll('{email}', encodeURIComponent(to));

/**
 * What `{{unsubscribe_url}}` stands for: the hosted URL for this recipient, else the mailto link; '' when neither exists.
 * @param {SmtpConfig} cfg
 * @param {string} to
 * @returns {string}
 */
export function unsubscribeLink(cfg, to) {
  return cfg.unsubscribeUrl ? unsubscribeUrlFor(cfg, to) : unsubscribeMailtoLink(cfg);
}

/**
 * Message-ID, Date, Reply-To and List-Unsubscribe fields for one recipient.
 * The Message-ID is unique per message and on the sender's own domain.
 * @param {SmtpConfig} cfg
 * @param {string} to
 * @returns {BulkFields}
 */
export function bulkFields(cfg, to) {
  /** @type {string[]} */
  const targets = [];
  /** @type {MailHeaders} */
  const headers = {};
  if (cfg.unsubscribeUrl) {
    targets.push(`<${unsubscribeUrlFor(cfg, to)}>`);
    headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
  }
  const mailto = unsubscribeMailtoLink(cfg);
  if (mailto) targets.push(`<${mailto}>`);
  if (targets.length) headers['List-Unsubscribe'] = targets.join(', ');

  return {
    messageId: `<${randomUUID()}@${addressDomain(cfg.from)}>`,
    date: new Date(),
    ...(cfg.replyTo ? { replyTo: cfg.replyTo } : {}),
    headers,
  };
}
