// DNS deliverability pre-flight checks (MX, SPF, DMARC, DKIM) via Node's built-in resolver.

import { promises as dns } from 'node:dns';
import { addressDomain } from './mailer.mjs';

const DEFAULT_DKIM_SELECTORS = ['default', 'google', 'selector1', 'selector2', 'k1', 's1', 'dkim', 'mail'];
const SELECTOR_RE = /^[a-z0-9](?:[a-z0-9._-]{0,61}[a-z0-9])?$/i;
const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

/** @typedef {{ ok: boolean, status: 'pass' | 'warn' | 'fail', detail: string, record?: string, records?: string[], policy?: string, selector?: string, lookups?: number }} DnsCheckResult */
/**
 * @typedef {{
 *   domain: string,
 *   ok: boolean,
 *   checks: { mx: DnsCheckResult, spf: DnsCheckResult, dmarc: DnsCheckResult, dkim: DnsCheckResult },
 *   warnings: string[],
 *   summary: string,
 * }} SenderDnsReport
 */
/**
 * @typedef {{
 *   selector?: string,
 *   dkimSelectors?: string[],
 *   resolveMx?: (host: string) => Promise<Array<{ exchange: string, priority: number }>>,
 *   resolveTxt?: (host: string) => Promise<string[][]>,
 * }} InspectDnsOptions
 */

/**
 * Normalizes a `From` line or bare domain name into a lower-case DNS domain.
 * @param {unknown} fromOrDomain
 * @returns {string}
 */
export function normalizeSenderDomain(fromOrDomain) {
  const raw = String(fromOrDomain ?? '').trim();
  const domain = raw.includes('@') ? addressDomain(raw) : raw.toLowerCase();
  return DOMAIN_RE.test(domain) ? domain : '';
}

/** @param {string | undefined} selector */
export function validDkimSelector(selector) {
  return !selector || SELECTOR_RE.test(selector.trim());
}

/**
 * Counts RFC 7208 DNS-querying mechanisms in a single SPF record.
 * @param {string} record
 * @returns {number}
 */
export function countSpfLookups(record) {
  const tokens = record.trim().split(/\s+/).slice(1);
  let count = 0;
  for (const token of tokens) {
    const bare = token.replace(/^[+\-~?]/, '').toLowerCase();
    if (/^(include:|redirect=|exists:|a(?=$|[:/])|mx(?=$|[:/])|ptr(?=$|:))/.test(bare)) count++;
  }
  return count;
}

/** @param {() => Promise<T>} fn @param {T} fallback @template T */
async function safeResolve(fn, fallback) {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

/** @param {string[][]} chunks @returns {string[]} */
const flattenTxt = (chunks) => chunks.map((parts) => parts.join('')).filter(Boolean);

/** @param {string} domain @param {(host: string) => Promise<Array<{ exchange: string, priority: number }>>} resolveMx @returns {Promise<DnsCheckResult>} */
async function checkMx(domain, resolveMx) {
  const mx = await safeResolve(() => resolveMx(domain), []);
  if (!mx.length) {
    return { ok: false, status: 'fail', detail: `No MX records found for ${domain}`, records: [] };
  }
  const hosts = mx
    .slice()
    .sort((a, b) => a.priority - b.priority)
    .map((r) => String(r.exchange || '').replace(/\.$/, '').trim())
    .filter(Boolean);
  if (!hosts.length) {
    return { ok: false, status: 'fail', detail: `Null MX configured for ${domain}; domain refuses mail`, records: [] };
  }
  return { ok: true, status: 'pass', detail: `MX points to ${hosts.slice(0, 2).join(', ')}`, records: hosts };
}

/** @param {string} domain @param {(host: string) => Promise<string[][]>} resolveTxt @returns {Promise<DnsCheckResult>} */
async function checkSpf(domain, resolveTxt) {
  const txt = flattenTxt(await safeResolve(() => resolveTxt(domain), []));
  const spfRecords = txt.filter((r) => /^v=spf1(?:\s|$)/i.test(r));
  if (!spfRecords.length) {
    return { ok: false, status: 'fail', detail: `Missing SPF TXT record on ${domain}` };
  }
  if (spfRecords.length > 1) {
    return { ok: false, status: 'fail', detail: 'Multiple v=spf1 records violate RFC 7208 (merge into one)', record: spfRecords[0] };
  }
  const record = spfRecords[0];
  if (/(?:^|\s)\+all(?:\s|$)/i.test(record)) {
    return { ok: false, status: 'fail', detail: 'SPF uses "+all", allowing any server on the internet to spoof your domain', record };
  }
  const lookups = countSpfLookups(record);
  if (lookups > 10) {
    return { ok: false, status: 'fail', detail: `SPF triggers ${lookups} DNS lookups (RFC 7208 allows at most 10)`, record, lookups };
  }
  return { ok: true, status: 'pass', detail: `SPF configured (${lookups}/10 DNS lookups)`, record, lookups };
}

/** @param {string} domain @param {(host: string) => Promise<string[][]>} resolveTxt @returns {Promise<{ check: DnsCheckResult, warning?: string }>} */
async function checkDmarc(domain, resolveTxt) {
  const txt = flattenTxt(await safeResolve(() => resolveTxt(`_dmarc.${domain}`), []));
  const record = txt.find((r) => /^v=DMARC1\b/i.test(r));
  if (!record) {
    return { check: { ok: false, status: 'fail', detail: `Missing DMARC record at _dmarc.${domain}` } };
  }
  const policyMatch = record.match(/(?:^|;)\s*p\s*=\s*(none|quarantine|reject)\b/i);
  const policy = policyMatch ? policyMatch[1].toLowerCase() : 'unknown';
  if (policy === 'none') {
    return {
      check: { ok: true, status: 'warn', detail: 'DMARC uses p=none (monitoring only; consider p=quarantine or p=reject)', record, policy },
      warning: `DMARC on ${domain} is p=none; tighten to p=quarantine or p=reject once reports look clean.`,
    };
  }
  if (policy !== 'quarantine' && policy !== 'reject') {
    return { check: { ok: false, status: 'fail', detail: 'DMARC record is missing a valid p= policy tag', record, policy } };
  }
  return { check: { ok: true, status: 'pass', detail: `DMARC enforcing p=${policy}`, record, policy } };
}

/**
 * @param {string} domain
 * @param {string[]} selectors
 * @param {(host: string) => Promise<string[][]>} resolveTxt
 * @returns {Promise<{ check: DnsCheckResult, warning?: string }>}
 */
async function checkDkim(domain, selectors, resolveTxt) {
  for (const sel of selectors) {
    const host = `${sel}._domainkey.${domain}`;
    const txt = flattenTxt(await safeResolve(() => resolveTxt(host), []));
    const active = txt.find((r) => /(?:^|;)\s*p\s*=\s*[A-Za-z0-9+/]{8,}=*(?:\s*;|\s*$)/i.test(r));
    if (active) {
      return { check: { ok: true, status: 'pass', detail: `DKIM key published at selector "${sel}"`, selector: sel, record: active } };
    }
    const revoked = txt.find((r) => /\bv=DKIM1\b/i.test(r) || /(?:^|;)\s*p\s*=\s*(?:;|$)/i.test(r));
    if (revoked) {
      return {
        check: { ok: false, status: 'fail', detail: `Revoked or empty DKIM key at selector "${sel}"`, selector: sel, record: revoked },
        warning: `DKIM selector "${sel}" on ${domain} publishes an empty/revoked key.`,
      };
    }
  }
  return {
    check: {
      ok: false,
      status: 'warn',
      detail: `No DKIM TXT record found for tested selector(s): ${selectors.join(', ')}`,
    },
    warning: 'If your SMTP provider signs with a custom selector, enter that DKIM selector to verify.',
  };
}

/**
 * Inspects MX, SPF, DMARC, and DKIM DNS records for a sender address or domain.
 * @param {unknown} fromOrDomain
 * @param {InspectDnsOptions} [options]
 * @returns {Promise<SenderDnsReport>}
 */
export async function inspectSenderDns(fromOrDomain, options = {}) {
  const domain = normalizeSenderDomain(fromOrDomain);
  if (!domain) {
    throw new Error('Enter a valid From address or sender domain (such as news@example.com) first.');
  }
  const explicitSelector = String(options.selector ?? '').trim();
  if (!validDkimSelector(explicitSelector)) {
    throw new Error('DKIM selector can only contain letters, numbers, dots, underscores, or hyphens.');
  }

  const resolveMx = options.resolveMx || ((host) => dns.resolveMx(host));
  const resolveTxt = options.resolveTxt || ((host) => dns.resolveTxt(host));
  const selectors = explicitSelector
    ? [explicitSelector]
    : (options.dkimSelectors?.length ? options.dkimSelectors : DEFAULT_DKIM_SELECTORS);

  const [mx, spf, dmarcOutcome, dkimOutcome] = await Promise.all([
    checkMx(domain, resolveMx),
    checkSpf(domain, resolveTxt),
    checkDmarc(domain, resolveTxt),
    checkDkim(domain, selectors, resolveTxt),
  ]);

  const dmarc = dmarcOutcome.check;
  const dkim = dkimOutcome.check;
  /** @type {string[]} */
  const warnings = [];
  if (dmarcOutcome.warning) warnings.push(dmarcOutcome.warning);
  if (dkimOutcome.warning) warnings.push(dkimOutcome.warning);

  // Core deliverability readiness requires MX, valid SPF, and a valid DMARC record;
  // custom provider DKIM selectors may differ from defaults when no selector is specified.
  const ok = mx.ok && spf.ok && dmarc.ok && (explicitSelector ? dkim.ok : true);
  const summary = ok
    ? `DNS authentication looks ready for ${domain}${warnings.length ? ` (${warnings.length} advisory)` : ''}.`
    : `Fix missing or invalid DNS records on ${domain} before bulk sending.`;

  return { domain, ok, checks: { mx, spf, dmarc, dkim }, warnings, summary };
}
