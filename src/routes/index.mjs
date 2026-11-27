import { httpError } from '../lib/errors.mjs';
import { routes as recipientRoutes } from './recipients.mjs';
import { routes as scheduleRoutes } from './schedule.mjs';
import { routes as sendRoutes } from './send.mjs';
import { routes as settingsRoutes } from './settings.mjs';
import { routes as suppressionRoutes } from './suppression.mjs';
import { routes as templateRoutes } from './templates.mjs';

/** @typedef {import('node:http').IncomingMessage} IncomingMessage */
/** @typedef {import('node:http').ServerResponse} ServerResponse */
/**
 * @typedef {{
 *   root: string,
 *   dataDir: string,
 *   templateDir: string,
 *   logPath: string,
 *   suppressionPath: string,
 *   schedulePath: string,
 *   graceMs: number,
 *   tickMs: number,
 *   appVersion: string,
 *   authOn: boolean,
 *   configFilePath: string,
 *   isShuttingDown: () => boolean,
 * }} ServerState
 */
/**
 * @typedef {{
 *   req: IncomingMessage,
 *   res: ServerResponse,
 *   url: URL,
 *   pathname: string,
 *   match: RegExpMatchArray | null,
 *   readJson: (limit?: number) => Promise<Record<string, unknown>>,
 *   json: (code: number, body: unknown) => void,
 *   fail: (code: number, message: string) => void,
 *   state: ServerState,
 * }} RouteContext
 */
/**
 * @typedef {{
 *   method: string,
 *   path?: string,
 *   pattern?: RegExp,
 *   handler: (ctx: RouteContext) => Promise<unknown> | unknown,
 * }} RouteDef
 */

/** @param {ServerResponse} res @param {number} code @param {unknown} body */
export function json(res, code, body) {
  const payload = JSON.stringify(body);
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Length', Buffer.byteLength(payload));
  res.end(payload);
}

/** @param {ServerResponse} res @param {number} code @param {string} message */
export const fail = (res, code, message) => json(res, code, { error: message });

/**
 * @param {IncomingMessage} req
 * @param {number} [limit]
 * @returns {Promise<Record<string, unknown>>}
 */
export async function readJson(req, limit = 2 * 1024 * 1024) {
  let size = 0;
  /** @type {Buffer[]} */
  const chunks = [];
  for await (const chunk of req) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    size += buf.length;
    if (size > limit) throw httpError(413, 'Request body too large');
    chunks.push(buf);
  }
  if (!chunks.length) return {};
  /** @type {unknown} */
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('Invalid JSON body');
  }
  // Every route reads fields off the result, so null, arrays and scalars
  // would surface as a TypeError and a 500.
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('Invalid JSON body: expected an object');
  }
  return /** @type {Record<string, unknown>} */ (body);
}

/** @type {RouteDef[]} */
export const apiRoutes = [
  ...settingsRoutes,
  ...recipientRoutes,
  ...templateRoutes,
  ...sendRoutes,
  ...suppressionRoutes,
  ...scheduleRoutes,
];

/**
 * Find the matching API route and run its handler; returns false if none matched.
 * @param {IncomingMessage} req
 * @param {ServerResponse} res
 * @param {URL} url
 * @param {ServerState} state
 * @returns {Promise<boolean>}
 */
export async function dispatchApi(req, res, url, state) {
  const pathname = url.pathname;
  for (const def of apiRoutes) {
    if (req.method !== def.method) continue;
    /** @type {RegExpMatchArray | null} */
    let match = null;
    if (def.path !== undefined) {
      if (pathname !== def.path) continue;
    } else if (def.pattern) {
      match = pathname.match(def.pattern);
      if (!match) continue;
    } else {
      continue;
    }
    await def.handler({
      req,
      res,
      url,
      pathname,
      match,
      readJson: (limit) => readJson(req, limit),
      json: (code, body) => json(res, code, body),
      fail: (code, message) => fail(res, code, message),
      state,
    });
    return true;
  }
  return false;
}
