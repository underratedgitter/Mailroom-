import {
  campaignDeliveryLists,
  campaignSummaries,
  formatReportCsv,
  loadSuppressed,
  readLog,
  recipientsFromFile,
} from '../lib/core.mjs';
import { badRequest } from '../lib/errors.mjs';
import { intParam, paginate } from './index.mjs';
import { realRoot, safePath } from './templates.mjs';

/** @typedef {import('./index.mjs').RouteDef} RouteDef */
/** @typedef {import('../lib/core.mjs').Recipient} Recipient */

/** @type {RouteDef[]} */
export const routes = [
  {
    method: 'GET',
    path: '/api/campaigns',
    handler: ({ url, json, state }) => {
      const all = campaignSummaries(readLog(state.logPath));
      const limit = intParam(url.searchParams.get('limit'), null, { min: 1, max: 500 });
      const offset = intParam(url.searchParams.get('offset'), 0, { min: 0 }) ?? 0;
      const q = url.searchParams.get('q') || '';
      const page = paginate(all, { q, limit, offset, match: (c, needle) => c.id.toLowerCase().includes(needle) });
      return json(200, {
        campaigns: page.items,
        total: page.total,
        filtered: page.filtered,
        limit: page.limit,
        offset: page.offset,
      });
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/campaigns\/([^/]+)\/export$/,
    handler: ({ res, url, match, fail, state }) => {
      let campaignId;
      try {
        campaignId = decodeURIComponent(match?.[1] || '');
      } catch {
        return fail(400, 'Invalid campaign name');
      }
      const kind = url.searchParams.get('kind') || 'sent';
      if (!['sent', 'failed', 'unsent'].includes(kind)) {
        return fail(400, 'Invalid export kind (expected sent, failed, or unsent)');
      }

      const csvParam = url.searchParams.get('csv') || '';
      /** @type {Recipient[]} */
      let csvRecipients = [];
      if (csvParam) {
        const csvPath = safePath(csvParam, state, { roots: [state.dataDir], ext: ['.csv'] });
        if (csvPath === realRoot(state.suppressionPath)) {
          throw badRequest(`Not allowed: ${csvParam}`);
        }
        csvRecipients = recipientsFromFile(csvPath).recipients;
      }
      if (kind === 'unsent' && !csvParam) {
        return fail(400, 'Select a recipient list to compute unsent addresses');
      }

      const entries = readLog(state.logPath);
      const suppressed = loadSuppressed(state.suppressionPath);
      const lists = campaignDeliveryLists(entries, csvRecipients, campaignId, suppressed);

      let csvText;
      if (kind === 'sent') {
        csvText = formatReportCsv(lists.sent, [
          { key: 'email', label: 'email' },
          { key: 'name', label: 'name' },
          { key: 'company', label: 'company' },
          { key: 'at', label: 'sent_at' },
        ]);
      } else if (kind === 'failed') {
        csvText = formatReportCsv(lists.failed, [
          { key: 'email', label: 'email' },
          { key: 'name', label: 'name' },
          { key: 'company', label: 'company' },
          { key: 'responseCode', label: 'response_code' },
          { key: 'error', label: 'error' },
          { key: 'at', label: 'failed_at' },
        ]);
      } else {
        csvText = formatReportCsv(
          lists.unsent.map((r) => ({ email: r._email, name: r._name, company: r._company })),
          [
            { key: 'email', label: 'email' },
            { key: 'name', label: 'name' },
            { key: 'company', label: 'company' },
          ],
        );
      }

      const safeName = campaignId.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'campaign';
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Disposition', `attachment; filename="${safeName}-${kind}.csv"`);
      res.setHeader('Content-Length', Buffer.byteLength(csvText));
      res.end(csvText);
      return undefined;
    },
  },
];
