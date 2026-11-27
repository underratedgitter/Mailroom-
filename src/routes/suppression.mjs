import { addSuppressed, loadSuppressed } from '../lib/core.mjs';
import { rel } from './templates.mjs';

/** @typedef {import('./index.mjs').RouteDef} RouteDef */

/** @type {RouteDef[]} */
export const routes = [
  {
    method: 'GET',
    path: '/api/suppression',
    handler: ({ json, state }) => {
      const emails = [...loadSuppressed(state.suppressionPath)].sort();
      return json(200, { path: rel(state.suppressionPath, state), count: emails.length, emails });
    },
  },
  {
    method: 'POST',
    path: '/api/suppress',
    // Body: { emails: "a@x.com\nb@x.com" | ["a@x.com"], reason?: "unsubscribe" }
    handler: async ({ readJson, json, fail, state }) => {
      const body = await readJson();
      const list = typeof body.emails === 'string' ? body.emails.split(/[\s,;]+/) : body.emails;
      if (!Array.isArray(list) || list.some((item) => typeof item !== 'string')) {
        return fail(400, 'emails must be a string or an array of strings');
      }
      const emails = list.map((item) => item.trim()).filter(Boolean);
      if (!emails.length) return fail(400, 'Give at least one address to suppress');
      const result = addSuppressed(state.suppressionPath, emails, typeof body.reason === 'string' ? body.reason : 'manual');
      if (!result.added.length && !result.already.length) {
        return fail(400, `Not an email address: ${result.invalid.join(', ')}`);
      }
      return json(200, { ...result, count: loadSuppressed(state.suppressionPath).size });
    },
  },
];
