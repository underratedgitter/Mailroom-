import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { badRequest, conflict, errCode, forbidden, httpError } from '../lib/errors.mjs';

/** @typedef {import('./index.mjs').RouteDef} RouteDef */
/** @typedef {{ root: string, dataDir: string, templateDir: string }} PathScope */

const ENCODED_TRAVERSAL_RE = /%(?:2e|2f|5c|00)/i;
const DOT_SEGMENT_RE = /(^|[\\/])\.\.([\\/]|$)/;

const BUNDLED_TEMPLATES = new Set([
  'bcci-connect.html',
  'bcci-connect-v2.html',
  'bcci-membership.html',
]);
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
/** @type {Record<string, 'png' | 'jpeg' | 'gif' | 'webp'>} */
const EXT_TO_FORMAT = { '.png': 'png', '.jpg': 'jpeg', '.jpeg': 'jpeg', '.gif': 'gif', '.webp': 'webp' };
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Real path of a root, whether or not the directory already exists. @param {string} path */
export function realRoot(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** @param {string} candidate @param {string[]} roots */
export function isInside(candidate, roots) {
  return roots.some((root) => candidate === root || candidate.startsWith(root + sep));
}

/**
 * @param {unknown} input
 * @param {string} label
 * @returns {string}
 */
function assertSafeRelativeInput(input, label) {
  if (typeof input !== 'string') throw badRequest(`Invalid ${label}`);
  const value = input.trim();
  if (!value) throw badRequest(`Missing ${label}`);
  if (value.includes('\0') || value.includes('\\') || ENCODED_TRAVERSAL_RE.test(value) || DOT_SEGMENT_RE.test(value)) {
    throw badRequest(`Not allowed: ${value}`);
  }
  return value;
}

/**
 * Only files inside data/ or templates/ may be referenced by the page.
 * @param {unknown} input
 * @param {PathScope} scope
 * @param {{ roots?: string[], ext?: string[] | null }} [options]
 * @returns {string}
 */
export function safePath(input, scope, { roots = [scope.dataDir, scope.templateDir], ext = null } = {}) {
  const value = assertSafeRelativeInput(input, 'file path');
  const absolute = resolve(scope.root, value);
  if (!isInside(absolute, roots)) throw badRequest(`Not allowed: ${value}`);
  if (ext && !ext.includes(extname(absolute).toLowerCase())) {
    throw badRequest(`Expected ${ext.join(' / ')}: ${value}`);
  }
  let stat;
  try {
    stat = lstatSync(absolute);
  } catch {
    throw badRequest(`File not found: ${value}`);
  }
  // Reject symlinks directly (even within the same root or when dangling).
  if (stat.isSymbolicLink()) throw badRequest(`Not allowed: ${value}`);
  if (!stat.isFile()) throw badRequest(`File not found: ${value}`);
  const real = realpathSync(absolute);
  if (!isInside(real, roots.map(realRoot))) {
    throw badRequest(`Not allowed: ${value}`);
  }
  return real;
}

/** @param {string} absolute @param {{ root: string }} scope */
export function rel(absolute, scope) {
  const root = absolute.startsWith(scope.root + sep) ? scope.root : realRoot(scope.root);
  return absolute.startsWith(root + sep) ? absolute.slice(root.length + 1).split(sep).join('/') : absolute;
}

/** @param {string} templatePath */
const isBundledTemplate = (templatePath) => BUNDLED_TEMPLATES.has(basename(templatePath));

/** @param {string} templatePath */
function assertEditableTemplate(templatePath) {
  if (isBundledTemplate(templatePath)) {
    throw forbidden('Bundled templates are read-only — duplicate it to edit a copy');
  }
}

/**
 * Top-level template HTML files inside templates/ only (excludes -assets/ and subfolders).
 * @param {unknown} input
 * @param {PathScope} scope
 * @returns {string}
 */
function safeTemplatePath(input, scope) {
  const real = safePath(input, scope, { roots: [scope.templateDir], ext: ['.html', '.htm'] });
  const file = basename(real);
  if (file.startsWith('.') || dirname(real) !== realRoot(scope.templateDir)) {
    throw badRequest(`Not allowed: ${input}`);
  }
  return real;
}

/**
 * @param {string} templatePath
 * @param {PathScope} scope
 * @param {{ create?: boolean }} [options]
 * @returns {string | null}
 */
function resolveSafeAssetsDir(templatePath, scope, { create = false } = {}) {
  const guess = templatePath.replace(/\.html?$/i, '') + '-assets';
  try {
    const stat = lstatSync(guess);
    // A symlinked assets folder must not become a window into the filesystem.
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw badRequest('Not allowed: invalid assets folder');
    }
  } catch (err) {
    if (errCode(err) !== 'ENOENT') throw err;
    if (!create) return null;
    mkdirSync(guess, { recursive: true });
  }
  const real = realpathSync(guess);
  if (!isInside(real, [realRoot(scope.templateDir)])) {
    throw badRequest('Not allowed: invalid assets folder');
  }
  return real;
}

/**
 * The `-assets` folder that sits beside a template, if there is one.
 * @param {string} templatePath
 * @param {PathScope} scope
 * @returns {string | null}
 */
export function assetsDirFor(templatePath, scope) {
  try {
    return resolveSafeAssetsDir(templatePath, scope, { create: false });
  } catch {
    return null;
  }
}

/**
 * @param {string} target
 * @param {string | Uint8Array} data
 */
function writeAtomicFile(target, data) {
  const dir = dirname(target);
  mkdirSync(dir, { recursive: true });
  const staging = join(dir, `.${basename(target)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    writeFileSync(staging, data, { flag: 'wx' });
    renameSync(staging, target);
  } catch (err) {
    rmSync(staging, { force: true });
    throw err;
  }
}

/**
 * @param {unknown} rawName
 * @returns {string}
 */
function normalizeTemplateName(rawName) {
  if (typeof rawName !== 'string') throw badRequest('Template name is required');
  let value = rawName.trim();
  if (!value) throw badRequest('Template name is required');
  if (value.includes('/') || value.includes('\\') || value.includes('\0') || value.includes(':')
    || value.includes('..') || ENCODED_TRAVERSAL_RE.test(value) || value.startsWith('.')) {
    throw badRequest(`Invalid template name: ${value}`);
  }
  value = value.replace(/\.html?$/i, '').trim();
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug || slug === '.' || slug === '..' || slug.startsWith('.')) {
    throw badRequest(`Invalid template name: ${rawName}`);
  }
  if (slug.length > 80) throw badRequest('Template name is too long');
  return `${slug}.html`;
}

/**
 * @param {unknown} rawName
 * @returns {{ filename: string, cid: string, ext: string }}
 */
function safeAssetFilename(rawName) {
  if (typeof rawName !== 'string') throw badRequest('Asset filename is required');
  const value = rawName.trim();
  if (!value) throw badRequest('Asset filename is required');
  if (value.includes('/') || value.includes('\\') || value.includes('\0') || value.includes(':')
    || value.includes('..') || ENCODED_TRAVERSAL_RE.test(value) || value.startsWith('.')) {
    throw badRequest(`Invalid asset filename: ${value}`);
  }
  const ext = extname(value).toLowerCase();
  if (!IMAGE_EXTS.has(ext)) {
    throw badRequest('Invalid image format: expected PNG, JPG, GIF, or WEBP');
  }
  const rawStem = value.slice(0, value.length - ext.length).trim();
  if (!rawStem || rawStem.startsWith('.')) {
    throw badRequest(`Invalid asset filename: ${value}`);
  }
  const stem = rawStem
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!stem || stem === '.' || stem === '..' || stem.startsWith('.')) {
    throw badRequest(`Invalid asset filename: ${value}`);
  }
  return { filename: `${stem}${ext}`, cid: stem, ext };
}

/**
 * @param {string | null} assetsDir
 * @returns {{ filename: string, cid: string, size: number }[]}
 */
function listAssetsFor(assetsDir) {
  if (!assetsDir) return [];
  return readdirSync(assetsDir)
    .filter((name) => !name.startsWith('.'))
    .sort()
    .flatMap((name) => {
      const full = join(assetsDir, name);
      let stat;
      try { stat = lstatSync(full); } catch { return []; }
      if (stat.isSymbolicLink() || !stat.isFile()) return [];
      const ext = extname(name).toLowerCase();
      if (!IMAGE_EXTS.has(ext)) return [];
      return [{ filename: name, cid: basename(name, ext), size: stat.size }];
    });
}

/**
 * @param {Buffer} buf
 * @returns {'png' | 'jpeg' | 'gif' | 'webp' | null}
 */
function detectImageFormat(buf) {
  if (buf.length >= 8
    && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
    && buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) {
    return 'png';
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'jpeg';
  }
  if (buf.length >= 6) {
    const head6 = buf.subarray(0, 6).toString('ascii');
    if (head6 === 'GIF87a' || head6 === 'GIF89a') return 'gif';
  }
  if (buf.length >= 12
    && buf.subarray(0, 4).toString('ascii') === 'RIFF'
    && buf.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'webp';
  }
  return null;
}

/**
 * @param {unknown} raw
 * @param {string} expectedExt
 * @returns {Buffer}
 */
function decodeImageBase64(raw, expectedExt) {
  if (typeof raw !== 'string') throw badRequest('Image data is required');
  let payload = raw.trim();
  if (!payload) throw badRequest('Image data is required');
  const expectedFormat = EXT_TO_FORMAT[expectedExt];
  if (!expectedFormat) throw badRequest('Invalid image format');

  if (payload.startsWith('data:')) {
    const match = payload.match(/^data:image\/(png|jpeg|jpg|gif|webp);base64,(.+)$/is);
    if (!match) throw badRequest('Invalid image data URL: expected PNG, JPG, GIF, or WEBP');
    const urlFormat = match[1].toLowerCase() === 'jpg' ? 'jpeg' : match[1].toLowerCase();
    if (urlFormat !== expectedFormat) {
      throw badRequest('Invalid image data URL: MIME type does not match file extension');
    }
    payload = match[2];
  }
  const compact = payload.replace(/\s+/g, '');
  if (!compact || !/^[A-Za-z0-9+/]+={0,2}$/.test(compact) || compact.length % 4 !== 0) {
    throw badRequest('Invalid base64 image payload');
  }
  const buf = Buffer.from(compact, 'base64');
  if (!buf.length) throw badRequest('Image payload is empty');
  if (buf.length > MAX_IMAGE_BYTES) throw httpError(413, 'Image exceeds 5 MB limit');
  if (detectImageFormat(buf) !== expectedFormat) {
    throw badRequest('Invalid image content: file signature does not match format');
  }
  return buf;
}

/**
 * @param {unknown} rawName
 * @param {PathScope} scope
 * @returns {string}
 */
function templateTargetForNew(rawName, scope) {
  const filename = normalizeTemplateName(rawName);
  assertEditableTemplate(filename);
  mkdirSync(scope.templateDir, { recursive: true });
  if (lstatSync(scope.templateDir).isSymbolicLink()) {
    throw badRequest('Not allowed: templates directory is a symlink');
  }
  const templatesReal = realpathSync(scope.templateDir);
  if (!isInside(templatesReal, [realRoot(scope.templateDir)])) {
    throw badRequest('Not allowed: invalid templates directory');
  }
  const target = join(templatesReal, filename);
  try {
    const stat = lstatSync(target);
    if (stat.isSymbolicLink()) throw badRequest(`Not allowed: ${filename}`);
    throw conflict(`A template named ${filename} already exists`);
  } catch (err) {
    if (errCode(err) !== 'ENOENT') throw err;
  }
  return target;
}

/** @param {PathScope} scope */
export function listTemplates(scope) {
  if (!existsSync(scope.templateDir)) return [];
  return readdirSync(scope.templateDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.name.startsWith('.') && /\.html?$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .map((name) => {
      const path = join(scope.templateDir, name);
      const assetsDir = assetsDirFor(path, scope);
      return {
        path: rel(path, scope),
        name,
        bundled: isBundledTemplate(path),
        assetsDir: assetsDir ? rel(assetsDir, scope) : null,
        assets: listAssetsFor(assetsDir).length,
      };
    });
}

/** @type {RouteDef[]} */
export const routes = [
  {
    method: 'GET',
    path: '/api/templates/read',
    handler: ({ url, json, state }) => {
      const templatePath = safeTemplatePath(url.searchParams.get('path'), state);
      const assetsDir = assetsDirFor(templatePath, state);
      return json(200, {
        path: rel(templatePath, state),
        name: basename(templatePath),
        bundled: isBundledTemplate(templatePath),
        html: readFileSync(templatePath, 'utf8'),
        assetsDir: assetsDir ? rel(assetsDir, state) : null,
        assets: listAssetsFor(assetsDir),
      });
    },
  },
  {
    method: 'POST',
    path: '/api/templates/save',
    handler: async ({ readJson, json, fail, state }) => {
      const body = await readJson();
      const html = typeof body.html === 'string' ? body.html : '';
      if (!html.trim()) return fail(400, 'Template HTML cannot be empty');

      if (body.path !== undefined) {
        if (typeof body.path !== 'string') return fail(400, 'Invalid template path');
        if (body.path.trim()) {
          const target = safeTemplatePath(body.path, state);
          assertEditableTemplate(target);
          writeAtomicFile(target, html);
          return json(200, { path: rel(target, state), name: basename(target) });
        }
      }

      const target = templateTargetForNew(body.name, state);
      writeAtomicFile(target, html);
      return json(201, { path: rel(target, state), name: basename(target) });
    },
  },
  {
    method: 'POST',
    path: '/api/templates/duplicate',
    handler: async ({ readJson, json, fail, state }) => {
      const body = await readJson();
      const srcPath = safeTemplatePath(body.path, state);
      const target = templateTargetForNew(body.name, state);
      const srcAssets = assetsDirFor(srcPath, state);
      const destAssetsGuess = target.replace(/\.html?$/i, '') + '-assets';

      // Validate destination assets folder does not pre-exist as a symlink before writing.
      let assetsCreated = false;
      if (srcAssets) {
        try {
          const stat = lstatSync(destAssetsGuess);
          if (stat.isSymbolicLink() || !stat.isDirectory()) {
            return fail(400, 'Not allowed: invalid destination assets folder');
          }
        } catch (err) {
          if (errCode(err) !== 'ENOENT') throw err;
          assetsCreated = true;
        }
      }

      writeAtomicFile(target, readFileSync(srcPath, 'utf8'));
      if (srcAssets) {
        try {
          const destAssets = resolveSafeAssetsDir(target, state, { create: true });
          if (destAssets) {
            for (const asset of listAssetsFor(srcAssets)) {
              writeAtomicFile(join(destAssets, asset.filename), readFileSync(join(srcAssets, asset.filename)));
            }
          }
        } catch (err) {
          rmSync(target, { force: true });
          if (assetsCreated) rmSync(destAssetsGuess, { recursive: true, force: true });
          throw err;
        }
      }
      return json(201, {
        path: rel(target, state),
        name: basename(target),
        assetsDir: srcAssets ? rel(destAssetsGuess, state) : null,
      });
    },
  },
  {
    method: 'POST',
    path: '/api/templates/delete',
    handler: async ({ readJson, json, state }) => {
      const body = await readJson();
      const target = safeTemplatePath(body.path, state);
      assertEditableTemplate(target);
      const assetsDir = assetsDirFor(target, state);
      rmSync(target, { force: true });
      if (assetsDir) rmSync(assetsDir, { recursive: true, force: true });
      return json(200, { deleted: rel(target, state) });
    },
  },
  {
    method: 'POST',
    path: '/api/templates/assets',
    handler: async ({ readJson, json, fail, state }) => {
      // 5 MB binary decoded -> ~6.7 MB base64 + JSON envelope.
      const body = await readJson(8 * 1024 * 1024);
      const templatePath = safeTemplatePath(body.template, state);
      assertEditableTemplate(templatePath);
      const { filename, cid, ext } = safeAssetFilename(body.filename);
      const bytes = decodeImageBase64(body.dataBase64, ext);
      const assetsDir = resolveSafeAssetsDir(templatePath, state, { create: true });
      if (!assetsDir) return fail(400, 'Invalid assets folder');
      const target = join(assetsDir, filename);
      try {
        if (lstatSync(target).isSymbolicLink()) return fail(400, 'Not allowed');
      } catch (err) {
        if (errCode(err) !== 'ENOENT') throw err;
      }
      writeAtomicFile(target, bytes);
      return json(201, { filename, cid, size: bytes.length, assetsDir: rel(assetsDir, state) });
    },
  },
  {
    method: 'POST',
    path: '/api/templates/assets/delete',
    handler: async ({ readJson, json, fail, state }) => {
      const body = await readJson();
      const templatePath = safeTemplatePath(body.template, state);
      assertEditableTemplate(templatePath);
      const { filename } = safeAssetFilename(body.filename);
      const assetsDir = resolveSafeAssetsDir(templatePath, state, { create: false });
      if (!assetsDir) return fail(404, 'Asset folder not found');
      const target = join(assetsDir, filename);
      let stat;
      try {
        stat = lstatSync(target);
      } catch {
        return fail(404, 'Asset not found');
      }
      if (stat.isSymbolicLink() || !stat.isFile()) return fail(400, 'Not allowed');
      if (!isInside(realpathSync(target), [realRoot(state.templateDir)])) return fail(400, 'Not allowed');
      rmSync(target, { force: true });
      return json(200, { deleted: filename });
    },
  },
];
