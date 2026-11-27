import { addSuppressed, loadSuppressed, loadSuppressionEntries, removeSuppressed } from '../lib/core.mjs';
import { rel } from './templates.mjs';

/** @typedef {import('./index.mjs').RouteDef} RouteDef */

/**
 * Normalizes string or string[] email input into trimmed non-empty tokens.
 * @param {unknown} raw
 * @returns {string[] | null}
 */
function suppressionInput(raw) {
  const list = typeof raw === 'string' ? raw.split(/[\s,;]+/) : raw;
  if (!Array.isArray(list) || list.some((item) => typeof item !== 'string')) return null;
  return list.map((item) => item.trim()).filter(Boolean);
}

/** @type {RouteDef[]} */
export const routes = [
  {
    method: 'GET',
    path: '/api/suppression',
    handler: ({ json, state }) => {
      const entries = loadSuppressionEntries(state.suppressionPath);
      return json(200, {
        path: rel(state.suppressionPath, state),
        count: entries.length,
        emails: entries.map((e) => e.email),
        entries,
      });
    },
  },
  {
    method: 'POST',
    path: '/api/suppress',
    // Body: { emails: "a@x.com\nb@x.com" | ["a@x.com"], reason?: "unsubscribe" }
    handler: async ({ readJson, json, fail, state }) => {
      const body = await readJson();
      const emails = suppressionInput(body.emails);
      if (!emails) return fail(400, 'emails must be a string or an array of strings');
      if (!emails.length) return fail(400, 'Give at least one address to suppress');
      const result = addSuppressed(state.suppressionPath, emails, typeof body.reason === 'string' ? body.reason : 'manual');
      if (!result.added.length && !result.already.length) {
        return fail(400, `Not an email address: ${result.invalid.join(', ')}`);
      }
      return json(200, { ...result, count: loadSuppressed(state.suppressionPath).size });
    },
  },
  {
    method: 'POST',
    path: '/api/unsuppress',
    // Body: { email: "a@x.com" } | { emails: "a@x.com\nb@x.com" | ["a@x.com"] }
    handler: async ({ readJson, json, fail, state }) => {
      const body = await readJson();
      const raw = body.emails !== undefined ? body.emails : body.email;
      const emails = suppressionInput(raw);
      if (!emails) return fail(400, 'emails must be a string or an array of strings');
      if (!emails.length) return fail(400, 'Give at least one address to remove');
      const result = removeSuppressed(state.suppressionPath, emails);
      if (!result.removed.length && !result.notFound.length) {
        return fail(400, `Not an email address: ${result.invalid.join(', ')}`);
      }
      return json(200, { ...result, count: loadSuppressed(state.suppressionPath).size });
    },
  },
];
