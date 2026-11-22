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

/** `Desk <desk@example.com>` -> `desk@example.com`. */
export function bareAddress(value) {
  const text = String(value ?? '').trim();
  const angled = text.match(/<([^<>]+)>\s*$/);
  return (angled ? angled[1] : text).trim();
}

/** The part after the last @, lower-cased; empty when there is none. */
export function addressDomain(value) {
  const address = bareAddress(value);
  const at = address.lastIndexOf('@');
  return at > 0 ? address.slice(at + 1).toLowerCase() : '';
}

/** The settings a send still needs; a local relay needs none. */
export function missingSmtpFields(cfg) {
  if (cfg.isLocal) return [];
  return [!cfg.user && 'SMTP_USER', !cfg.pass && 'SMTP_PASS'].filter(Boolean);
}

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

/** Why this configuration cannot send compliant mail, or null when it can. */
export function configIssue(cfg) {
  if (!addressDomain(cfg.from)) {
    return 'EMAIL_FROM must be a full address such as news@example.com: Message-ID and unsubscribe headers are built from its domain.';
  }
  if (cfg.unsubscribeUrl && !/^https:\/\/[^\s<>]+$/i.test(cfg.unsubscribeUrl)) {
    return 'UNSUBSCRIBE_URL must be an https:// URL with no spaces (RFC 8058 one-click needs HTTPS).';
  }
  return null;
}

/**
 * Message-ID, Date, Reply-To and List-Unsubscribe fields for one recipient.
 * The Message-ID is unique per message and on the sender's own domain.
 */
export function bulkFields(cfg, to) {
  const targets = [];
  const headers = {};
  if (cfg.unsubscribeUrl) {
    targets.push(`<${cfg.unsubscribeUrl.replaceAll('{email}', encodeURIComponent(to))}>`);
    headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
  }
  const mailbox = bareAddress(cfg.unsubscribeMailto || cfg.replyTo || cfg.from);
  if (mailbox) {
    const at = mailbox.lastIndexOf('@');
    targets.push(`<mailto:${encodeURIComponent(mailbox.slice(0, at))}${mailbox.slice(at)}?subject=unsubscribe>`);
  }
  if (targets.length) headers['List-Unsubscribe'] = targets.join(', ');

  return {
    messageId: `<${randomUUID()}@${addressDomain(cfg.from)}>`,
    date: new Date(),
    ...(cfg.replyTo ? { replyTo: cfg.replyTo } : {}),
    headers,
  };
}
