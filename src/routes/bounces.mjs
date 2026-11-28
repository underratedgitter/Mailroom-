// Authenticated bounce & spam-complaint webhook receiver (/api/webhooks/bounces).
// Accepts Mailroom events as well as AWS SES, Postmark, and Resend payloads,
// suppressing permanent hard bounces and complaints immediately while ignoring
// transient soft bounces.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { addSuppressed, emailRe, loadSuppressed } from '../lib/core.mjs';
import { httpError } from '../lib/errors.mjs';

/** @typedef {import('node:http').IncomingMessage} IncomingMessage */
/** @typedef {import('./index.mjs').RouteDef} RouteDef */

/**
 * Verifies Bearer token or `X-Mailroom-Signature: sha256=<hex>` over raw JSON bytes.
 * @param {IncomingMessage} req
 * @param {Buffer} rawBody
 * @param {string} secret
 * @returns {boolean}
 */
export function verifyWebhookSignature(req, rawBody, secret) {
  const expectedSecret = String(secret || '').trim();
  if (!expectedSecret) return false;

  const auth = String(req.headers.authorization || '').trim();
  if (auth.toLowerCase().startsWith('bearer ')) {
    const actual = Buffer.from(auth.slice(7).trim(), 'utf8');
    const target = Buffer.from(expectedSecret, 'utf8');
    return actual.length === target.length && timingSafeEqual(actual, target);
  }

  const header = String(req.headers['x-mailroom-signature'] || req.headers['x-hub-signature-256'] || '').trim();
  const actualHex = header.replace(/^sha256=/i, '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(actualHex)) return false;
  const expectedHex = createHmac('sha256', expectedSecret).update(rawBody).digest('hex');
  return timingSafeEqual(Buffer.from(actualHex, 'hex'), Buffer.from(expectedHex, 'hex'));
}

/** @param {unknown} value @returns {string[]} */
function emailList(value) {
  if (Array.isArray(value)) return value.flatMap((item) => emailList(item));
  if (value && typeof value === 'object') {
    const obj = /** @type {Record<string, unknown>} */ (value);
    return emailList(obj.emailAddress ?? obj.email ?? obj.address ?? obj.recipient ?? []);
  }
  if (typeof value !== 'string') return [];
  const trimmed = value.trim().toLowerCase();
  return emailRe.test(trimmed) ? [trimmed] : [];
}

/**
 * Classifies one webhook event into hard-bounce suppressions, complaints, or ignored soft bounces.
 * @param {unknown} raw
 * @returns {{ hardBounces: string[], complaints: string[], softCount: number }}
 */
function extractSignals(raw) {
  const hardBounces = /** @type {string[]} */ ([]);
  const complaints = /** @type {string[]} */ ([]);
  let softCount = 0;
  if (!raw || typeof raw !== 'object') return { hardBounces, complaints, softCount };

  const ev = /** @type {Record<string, unknown>} */ (raw);

  // Direct AWS SES notification shape
  const sesType = String(ev.notificationType || ev.eventType || '').toLowerCase();
  if (sesType === 'bounce' && ev.bounce && typeof ev.bounce === 'object') {
    const bounce = /** @type {Record<string, unknown>} */ (ev.bounce);
    const kind = String(bounce.bounceType || '').toLowerCase();
    const list = emailList(bounce.bouncedRecipients);
    if (kind === 'permanent' || kind === '') hardBounces.push(...list);
    else softCount += list.length || 1;
    return { hardBounces, complaints, softCount };
  }
  if (sesType === 'complaint' && ev.complaint && typeof ev.complaint === 'object') {
    const complaint = /** @type {Record<string, unknown>} */ (ev.complaint);
    complaints.push(...emailList(complaint.complainedRecipients));
    return { hardBounces, complaints, softCount };
  }

  // Direct Mailroom / Postmark / Resend / SendGrid shapes
  const type = String(ev.type || ev.Type || ev.event || '').toLowerCase();
  const data = ev.data && typeof ev.data === 'object' ? /** @type {Record<string, unknown>} */ (ev.data) : {};
  const list = emailList(ev.emails ?? ev.email ?? ev.Email ?? ev.recipient ?? ev.recipients ?? data.to ?? data.email ?? []);

  if (type.includes('complaint') || type === 'spamreport' || type === 'email.complained') {
    complaints.push(...list);
  } else if (type === 'soft-bounce' || type === 'softbounce' || ev.permanent === false || ev.RecordType === 'Bounce' && String(ev.Type) === 'SoftBounce') {
    softCount += list.length || 1;
  } else if (type.includes('bounce') || type === 'dropped' || type === 'email.bounced') {
    if (ev.bounceType && String(ev.bounceType).toLowerCase() === 'transient') softCount += list.length || 1;
    else hardBounces.push(...list);
  }

  return { hardBounces, complaints, softCount };
}

/** @type {RouteDef[]} */
export const routes = [
  {
    method: 'POST',
    path: '/api/webhooks/bounces',
    handler: async ({ req, json, fail, state, authenticated }) => {
      let rawSize = 0;
      /** @type {Buffer[]} */
      const chunks = [];
      for await (const chunk of req) {
        const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
        rawSize += buf.length;
        if (rawSize > 256 * 1024) throw httpError(413, 'Request body too large');
        chunks.push(buf);
      }
      const rawBody = Buffer.concat(chunks);
      const secret = process.env.MAILROOM_WEBHOOK_SECRET || '';
      if (!authenticated && !verifyWebhookSignature(req, rawBody, secret)) {
        return fail(401, 'Invalid webhook credentials');
      }

      /** @type {unknown} */
      let parsed;
      try {
        parsed = rawBody.length ? JSON.parse(rawBody.toString('utf8')) : {};
      } catch {
        return fail(400, 'Invalid JSON body');
      }
      if (!parsed || typeof parsed !== 'object') {
        return fail(400, 'Invalid JSON body: expected an object or array');
      }

      const items = Array.isArray(parsed)
        ? parsed
        : Array.isArray(/** @type {Record<string, unknown>} */ (parsed).events)
          ? /** @type {unknown[]} */ (/** @type {Record<string, unknown>} */ (parsed).events)
          : [parsed];

      /** @type {string[]} */
      const hardBounces = [];
      /** @type {string[]} */
      const complaints = [];
      let ignoredSoft = 0;
      for (const item of items) {
        const signals = extractSignals(item);
        hardBounces.push(...signals.hardBounces);
        complaints.push(...signals.complaints);
        ignoredSoft += signals.softCount;
      }

      const bounceRes = hardBounces.length ? addSuppressed(state.suppressionPath, hardBounces, 'hard-bounce') : { added: [], already: [], invalid: [] };
      const complaintRes = complaints.length ? addSuppressed(state.suppressionPath, complaints, 'complaint') : { added: [], already: [], invalid: [] };

      return json(200, {
        ok: true,
        added: [...new Set([...bounceRes.added, ...complaintRes.added])],
        already: [...new Set([...bounceRes.already, ...complaintRes.already])],
        ignoredSoft,
        count: loadSuppressed(state.suppressionPath).size,
      });
    },
  },
];
