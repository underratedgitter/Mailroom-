import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(ROOT, path), 'utf8');
const html = read('public/index.html');
const appFiles = readdirSync(join(ROOT, 'public/js'))
  .filter((f) => f.endsWith('.mjs'))
  .sort()
  .map((f) => read(`public/js/${f}`));
const app = appFiles.join('\n');
const css = read('public/styles.css');
const gui = read('src/gui.mjs');
const routeFiles = existsSync(join(ROOT, 'src/routes'))
  ? readdirSync(join(ROOT, 'src/routes')).filter((f) => f.endsWith('.mjs')).map((f) => read(`src/routes/${f}`))
  : [];

const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
const routes = [...html.matchAll(/data-route="([^"]+)"/g)].map((m) => m[1]);

test('every element the script looks up exists in the page', () => {
  const wanted = new Set([...app.matchAll(/\bui\.([A-Za-z][A-Za-z0-9]*)/g)].map((m) => m[1]));
  // Looked up by computed name: ui['step' + Name] and ui['panel' + Name].
  for (const name of ['Mailbox', 'Compose', 'Recipients', 'Test']) wanted.add('step' + name);
  for (const name of ['Saved', 'Paste', 'Upload']) wanted.add('panel' + name);

  const missing = [...wanted].filter((id) => !ids.has(id));
  assert.deepEqual(missing, []);
});

test('each navigation link opens a view with a heading, and every view has a link', () => {
  assert.deepEqual(routes, ['overview', 'compose', 'recipients', 'send', 'schedule', 'suppression', 'settings']);
  for (const route of routes) {
    const view = 'view' + route[0].toUpperCase() + route.slice(1);
    assert.ok(ids.has(view), view + ' is missing');
    assert.match(html, new RegExp('<section[^>]*id="' + view + '"[^>]*aria-labelledby="h' + route[0].toUpperCase() + route.slice(1) + '"'));
    assert.ok(app.includes("id: '" + route + "'"), route + ' is not routed in public/js');
    assert.match(html, new RegExp('href="#/' + route + '"'));
  }
});

test('the page has landmarks, a skip link and labelled controls', () => {
  assert.match(html, /<html lang="en">/);
  assert.match(html, /<main\b[^>]*id="main"/);
  assert.match(html, /<nav\b[^>]*aria-label="Main"/);
  assert.match(html, /<a class="skip" href="#main">/);
  assert.equal([...html.matchAll(/<h1\b/g)].length, routes.length);
  assert.match(html, /<dialog\b[^>]*aria-labelledby="confirmTitle"/);

  const labelled = new Set([...html.matchAll(/<label\b[^>]*\bfor="([^"]+)"/g)].map((m) => m[1]));
  for (const control of html.matchAll(/<(input|select|textarea)\b([^>]*)>/g)) {
    const id = control[2].match(/\bid="([^"]+)"/)?.[1];
    const named = /\baria-label(ledby)?=/.test(control[2]);
    // The confirm checkbox sits inside its own <label>.
    assert.ok(named || id === 'confirmCheck' || labelled.has(id), (id || control[0]) + ' has no label');
  }
});

test('every API endpoint the server offers is reachable from the page', () => {
  const login = read('public/login.js');
  const serverSources = [gui, ...routeFiles].join('\n');
  const literal = [
    ...[...serverSources.matchAll(/pathname === '(\/api\/[^']+)'/g)].map((m) => m[1]),
    ...[...serverSources.matchAll(/\bpath:\s*'(\/api\/[^']+)'/g)].map((m) => m[1]),
  ];
  const wanted = new Set([...literal, '/api/schedule/', '/api/jobs/']);
  assert.ok(wanted.size >= 15, 'expected the server routes to be found');

  const sources = app + login;
  for (const path of wanted) {
    assert.ok(sources.includes("'" + path) || sources.includes('"' + path), path + ' is not used by the page');
  }
  // Parameterised routes: schedule/:id/(run|cancel) and jobs/:id/(events|cancel).
  for (const part of ["'/run'", "'/cancel'", '/events', '/cancel']) assert.ok(app.includes(part), part);
});

test('the stylesheet handles dark mode, reduced motion and keyboard focus', () => {
  assert.match(css, /@media \(prefers-color-scheme: dark\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /:focus-visible\s*\{[^}]*outline:/);
  assert.match(read('public/login.css'), /@media \(prefers-color-scheme: dark\)/);
});

test('the script patches in place: no innerHTML, and preview frames reload only on change', () => {
  assert.doesNotMatch(app, /\.innerHTML\s*=/);
  assert.doesNotMatch(app, /\beval\(|new Function\(/);
  assert.match(app, /if \(ui\.preview\.srcdoc !== data\.html\) ui\.preview\.srcdoc = data\.html;/);
  assert.match(app, /function reconcile\(/);
  assert.match(app, /function setText\(/);
});

test('the paste box and other hidden panels stay hidden by the [hidden] attribute', () => {
  assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important;?\s*\}/);
  assert.match(html, /<div class="tabpanel"[^>]*id="panelPaste"[^>]*\shidden>/);
});

test('settings offer the TLS mode and the optional delivery fields, and send them', () => {
  assert.match(html, /<select id="setSecure">[\s\S]*?value="true"[\s\S]*?value="false"[\s\S]*?<\/select>/);
  const payload = app.slice(app.indexOf('function settingsPayload()'), app.indexOf('function setSettingsStatus'));
  for (const key of ['secure', 'replyTo', 'unsubscribeUrl', 'maxPerHour']) assert.match(payload, new RegExp('\\b' + key + ':'));
});

test('the send checklist shows link warnings, and the suppression copy does not promise automatic unsubscribes', () => {
  assert.match(html, /data-check="links"[\s\S]*?id="chkLinks"/);
  assert.match(app, /links: \{[\s\S]*?p\.warnings/);
  for (const text of [html, app]) assert.doesNotMatch(text, /or that unsubscribe, appear here/);
  assert.match(html, /Unsubscribe requests are not added automatically/);
});

test('schedule supports rescheduling and saved recipient lists can be deleted cleanly', () => {
  assert.ok(ids.has('deleteCsvBtn'));
  assert.ok(ids.has('rescheduleDialog'));
  assert.match(app, /\/api\/csv\/delete/);
  assert.match(app, /\/reschedule/);
});

test('overview exposes campaign reports and sent/failed/unsent CSV export links', () => {
  assert.match(app, /\/api\/campaigns/);
  assert.match(app, /\/export\?/);
  assert.match(app, /exportHref\([^)]*'sent'/);
  assert.match(app, /exportHref\([^)]*'failed'/);
  assert.match(app, /exportHref\([^)]*'unsent'/);
  assert.ok(ids.has('reportCsv'));
});

test('compose includes the template studio tabs, editor, asset manager, and name dialog', () => {
  for (const id of ['composeTabs', 'panelComposeStudio', 'studioHtml', 'assetList', 'nameDialog']) {
    assert.ok(ids.has(id), id + ' is missing');
  }
  assert.match(html, /<div class="tabpanel"[^>]*id="panelComposeStudio"[^>]*\shidden>/);
  for (const route of ['/api/templates/read', '/api/templates/save', '/api/templates/duplicate', '/api/templates/delete', '/api/templates/assets', '/api/templates/assets/delete']) {
    assert.ok(app.includes(route), route + ' missing from public/js');
  }
});

test('the suppression view displays reason and date and removes addresses via /api/unsuppress', () => {
  assert.match(app, /\/api\/unsuppress/);
  assert.match(app, /function renderSuppression[\s\S]*?\.reason/);
  assert.match(app, /function renderSuppression[\s\S]*?\.added/);
  assert.match(app, /Remove/);
});
