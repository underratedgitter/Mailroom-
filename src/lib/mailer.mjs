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
//   MAILROOM_PUBLIC_URL  https:// origin of this Mailroom server for signed
//                        per-recipient /unsubscribe?token=... links
//   UNSUBSCRIBE_URL      external https:// endpoint you host that accepts a
//                        one-click POST; {email} is replaced with the recipient

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

const SIMPLE_EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

/** Signs an HMAC-SHA256 unsubscribe token binding a normalized email address. */
export function signUnsubscribeToken(email, secret) {
  const normalized = String(email ?? '').trim().toLowerCase();
  const key = String(secret ?? '').trim();
  if (!SIMPLE_EMAIL_RE.test(normalized) || !key) return '';
  const payload = Buffer.from(JSON.stringify({ e: normalized }), 'utf8').toString('base64url');
  const sig = createHmac('sha256', key).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

/** Verifies an unsubscribe token and returns `{ email }`, or `null` if invalid/tampered. */
export function verifyUnsubscribeToken(token, secret) {
  const key = String(secret ?? '').trim();
  const parts = String(token ?? '').split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1] || !key) return null;
  const [payload, sig] = parts;
  const expected = createHmac('sha256', key).update(payload).digest('base64url');
  const actualBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expected);
  if (actualBuf.length !== expectedBuf.length || !timingSafeEqual(actualBuf, expectedBuf)) {
    return null;
  }
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const email = String(data?.e || '').trim().toLowerCase();
    return SIMPLE_EMAIL_RE.test(email) ? { email } : null;
  } catch {
    return null;
  }
}

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
    publicUrl: (env.MAILROOM_PUBLIC_URL || '').trim().replace(/\/+$/, ''),
    unsubscribeSecret: String(env.MAILROOM_UNSUBSCRIBE_SECRET || '').trim(),
    isLocal,
    configured: Boolean((user && pass) || isLocal),
  };
}

/** Why an UNSUBSCRIBE_URL cannot be used, or null (empty means none). */
export function unsubscribeUrlIssue(url) {
  if (url && !/^https:\/\/[^\s<>]+$/i.test(url)) {
    return 'UNSUBSCRIBE_URL must be an https:// URL with no spaces (RFC 8058 one-click needs HTTPS).';
  }
  return null;
}

/** Why MAILROOM_PUBLIC_URL cannot be used, or null (empty means none). */
export function publicUrlIssue(url) {
  if (!url) return null;
  if (!/^https:\/\/[^\s<>?#]+$/i.test(url)) {
    return 'MAILROOM_PUBLIC_URL must be an https:// URL with no spaces, query, or hash (RFC 8058 one-click needs HTTPS).';
  }
  try {
    new URL(url);
  } catch {
    return 'MAILROOM_PUBLIC_URL is not a valid https:// URL.';
  }
  return null;
}

/** Why this configuration cannot send compliant mail, or null when it can. */
export function configIssue(cfg) {
  if (!addressDomain(cfg.from)) {
    return 'EMAIL_FROM must be a full address such as news@example.com: Message-ID and unsubscribe headers are built from its domain.';
  }
  return unsubscribeUrlIssue(cfg.unsubscribeUrl) || publicUrlIssue(cfg.publicUrl);
}

/** `mailto:` link to the unsubscribe mailbox (UNSUBSCRIBE_MAILTO, else Reply-To, else From), or ''. */
function unsubscribeMailtoLink(cfg) {
  const mailbox = bareAddress(cfg.unsubscribeMailto || cfg.replyTo || cfg.from);
  if (!mailbox) return '';
  const at = mailbox.lastIndexOf('@');
  return `mailto:${encodeURIComponent(mailbox.slice(0, at))}${mailbox.slice(at)}?subject=unsubscribe`;
}

const unsubscribeUrlFor = (cfg, to) => cfg.unsubscribeUrl.replaceAll('{email}', encodeURIComponent(to));

function signedUnsubscribeUrlFor(cfg, to) {
  if (!cfg.publicUrl || !cfg.unsubscribeSecret) return '';
  const token = signUnsubscribeToken(to, cfg.unsubscribeSecret);
  return token ? `${cfg.publicUrl}/unsubscribe?token=${encodeURIComponent(token)}` : '';
}

function httpUnsubscribeTarget(cfg, to) {
  return cfg.unsubscribeUrl ? unsubscribeUrlFor(cfg, to) : signedUnsubscribeUrlFor(cfg, to);
}

/** What `{{unsubscribe_url}}` stands for: the hosted URL for this recipient, else the mailto link; '' when neither exists. */
export function unsubscribeLink(cfg, to) {
  return httpUnsubscribeTarget(cfg, to) || unsubscribeMailtoLink(cfg);
}

/**
 * Message-ID, Date, Reply-To and List-Unsubscribe fields for one recipient.
 * The Message-ID is unique per message and on the sender's own domain.
 */
export function bulkFields(cfg, to) {
  const targets = [];
  const headers = {};
  const httpsTarget = httpUnsubscribeTarget(cfg, to);
  if (httpsTarget) {
    targets.push(`<${httpsTarget}>`);
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
