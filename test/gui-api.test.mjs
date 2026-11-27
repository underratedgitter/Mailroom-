import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CSV, startServer, post, get } from './helpers/server.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE = 'templates/bcci-connect.html';
const roles = (columns) => Object.fromEntries(columns.map((c) => [c.name, c.role]));

test('the roster and the preview say how each CSV column is used', async (t) => {
  const server = await startServer();
  t.after(server.stop);
  const csv = `${dirname(CSV)}/columns.csv`;
  writeFileSync(join(ROOT, csv), 'Email,Contact,Organisation,Role\nrep@example.com,Rep,Acme,Treasurer\n');

  const roster = await post(server.base, '/api/roster', { csv });
  assert.equal(roster.status, 200);
  assert.deepEqual(roles(roster.data.columns), { email: 'email', contact: 'name', organisation: 'company', role: 'field' });

  const preview = await post(server.base, '/api/preview', { csv, html: TEMPLATE, subject: 'Hi {{contact}}, {{role}} {{missing}}' });
  assert.equal(preview.status, 200);
  assert.deepEqual(roles(preview.data.columns), roles(roster.data.columns));
  const found = Object.fromEntries(preview.data.placeholders.map((p) => [p.name, p.status]));
  assert.equal(found.contact, 'column');
  assert.equal(found.role, 'column');
  assert.equal(found.missing, 'missing');
});

test('built-in merge fields are never reported as missing', async (t) => {
  const server = await startServer();
  t.after(server.stop);
  const preview = await post(server.base, '/api/preview', {
    raw: 'one@example.com, One', html: TEMPLATE, subject: '{{Name}} {{company}} {{email}}',
  });
  assert.equal(preview.status, 200);
  assert.ok(preview.data.placeholders.every((p) => p.status === 'builtin'), JSON.stringify(preview.data.placeholders));
  assert.deepEqual(preview.data.columns.map((c) => c.name), ['email', 'name', 'company']);
});

test('a dry run validates a pasted CSV without writing a file', async (t) => {
  const server = await startServer();
  t.after(server.stop);
  const text = 'email,name,plan\na@example.com,A,gold\nnot-an-email,B,silver\na@example.com,Dup,gold\n';

  const dry = await post(server.base, '/api/recipients', { text, format: 'csv', dryRun: true, name: 'dry-run-list' });
  assert.equal(dry.status, 200);
  assert.equal(dry.data.total, 1);
  assert.equal(dry.data.invalid, 1);
  assert.equal(dry.data.duplicates, 1);
  assert.equal(dry.data.recipients[0].email, 'a@example.com');
  assert.equal(roles(dry.data.columns).plan, 'field');
  assert.equal(existsSync(join(ROOT, 'data', 'dry-run-list.csv')), false);

  const empty = await post(server.base, '/api/recipients', { text: '   ', dryRun: true });
  assert.equal(empty.status, 200);
  assert.equal(empty.data.total, 0);

  const headerOnly = await post(server.base, '/api/recipients', { text: 'email,name', format: 'csv', dryRun: true });
  assert.equal(headerOnly.status, 400);
});

test('saving a CSV keeps its extra columns for merge fields', async (t) => {
  const server = await startServer();
  t.after(server.stop);
  const text = 'email,name,plan\na@example.com,A,gold\nb@example.com,B,silver\n';

  const saved = await post(server.base, '/api/recipients', { text, format: 'csv', name: 'gui-api-plans' });
  assert.equal(saved.status, 201);
  t.after(() => rmSync(join(ROOT, saved.data.path), { force: true }));
  assert.equal(saved.data.recipients, 2);
  assert.match(readFileSync(join(ROOT, saved.data.path), 'utf8'), /^email,name,plan\n/);

  const preview = await post(server.base, '/api/preview', { csv: saved.data.path, html: TEMPLATE, subject: '{{plan}} member' });
  assert.equal(preview.data.subject, 'gold member');

  const bad = await post(server.base, '/api/recipients', { text: 'name\nNobody', format: 'csv', name: 'gui-api-bad' });
  assert.equal(bad.status, 400);
});

test('a saved list can never take the suppression list\'s file name', async (t) => {
  const suppressionFile = join(ROOT, 'data', 'suppressed.csv');
  const existed = existsSync(suppressionFile);
  const server = await startServer({ env: { SUPPRESSION_FILE: suppressionFile } });
  t.after(server.stop);

  const saved = await post(server.base, '/api/recipients', { text: 'a@example.com', name: 'suppressed' });
  assert.equal(saved.status, 201);
  t.after(() => rmSync(join(ROOT, saved.data.path), { force: true }));
  assert.notEqual(saved.data.path, 'data/suppressed.csv');
  assert.equal(existsSync(suppressionFile), existed);
});

test('a CSV with an unclosed quote is reported to the user, not silently truncated', async (t) => {
  const server = await startServer();
  t.after(server.stop);
  const text = 'email,name\na@example.com,A\nb@example.com,"B\nc@example.com,C\n';
  const dry = await post(server.base, '/api/recipients', { text, format: 'csv', dryRun: true });
  assert.equal(dry.status, 400);
  assert.match(dry.data.error, /Unclosed quote starting on line 3/);
});

test('POST /api/csv/delete removes saved CSVs safely and never deletes the suppression file or symlinks', async (t) => {
  const supName = `sup-protect-${process.pid}.csv`;
  const supFile = join(ROOT, 'data', supName);
  const linkName = `link-del-${process.pid}.csv`;
  const linkPath = join(ROOT, 'data', linkName);
  const targetFile = join(ROOT, 'data', `real-del-${process.pid}.csv`);
  const server = await startServer({ env: { SUPPRESSION_FILE: supFile } });
  t.after(async () => {
    rmSync(supFile, { force: true });
    rmSync(linkPath, { force: true });
    rmSync(targetFile, { force: true });
    await server.stop();
  });

  const saved = await post(server.base, '/api/recipients', { text: 'a@example.com,A\n', name: `temp-del-${process.pid}` });
  assert.equal(saved.status, 201);
  t.after(() => rmSync(join(ROOT, saved.data.path), { force: true }));
  assert.equal(existsSync(join(ROOT, saved.data.path)), true);

  const deleted = await post(server.base, '/api/csv/delete', { path: saved.data.path });
  assert.equal(deleted.status, 200);
  assert.equal(deleted.data.ok, true);
  assert.equal(existsSync(join(ROOT, saved.data.path)), false);
  const state = await get(server.base, '/api/state');
  assert.equal(state.data.csvs.some((c) => c.path === saved.data.path), false);

  // Refuses deleting missing files, traversal, non-CSV, symlinks, and the suppression file.
  assert.equal((await post(server.base, '/api/csv/delete', { path: saved.data.path })).status, 400);
  assert.equal((await post(server.base, '/api/csv/delete', { path: '../package.json' })).status, 400);

  await post(server.base, '/api/suppress', { emails: 'protect@example.com' });
  const supDel = await post(server.base, '/api/csv/delete', { path: `data/${supName}` });
  assert.equal(supDel.status, 400);
  assert.equal(existsSync(supFile), true);

  writeFileSync(targetFile, 'email\na@example.com\n');
  symlinkSync(targetFile, linkPath);
  const symDel = await post(server.base, '/api/csv/delete', { path: `data/${linkName}` });
  assert.equal(symDel.status, 400);
  assert.equal(existsSync(linkPath), true);
  assert.equal(existsSync(targetFile), true);
});

test('template studio creates, reads, saves, uploads/deletes assets, duplicates, deletes, and guards paths', async (t) => {
  const server = await startServer();
  const stem = `studio-test-${process.pid}`;
  const copyStem = `${stem}-copy`;
  const cleanup = () => {
    for (const s of [stem, copyStem, `sym-${process.pid}`]) {
      rmSync(join(ROOT, 'templates', `${s}.html`), { force: true });
      rmSync(join(ROOT, 'templates', `${s}-assets`), { recursive: true, force: true });
    }
    rmSync(join(ROOT, 'templates', `.hidden-${process.pid}.html`), { force: true });
  };
  t.after(async () => { cleanup(); await server.stop(); });

  // Read existing bundled template + assets.
  const bundled = await get(server.base, '/api/templates/read?path=' + encodeURIComponent(TEMPLATE));
  assert.equal(bundled.status, 200);
  assert.match(bundled.data.html, /<html/i);
  assert.ok(bundled.data.assets.length > 0);

  // Create new template.
  const created = await post(server.base, '/api/templates/save', {
    name: stem,
    html: '<p>Hi {{name}} <img src="cid:badge"><a href="{{unsubscribe_url}}">u</a></p>',
  });
  assert.equal(created.status, 201);
  assert.equal(created.data.path, `templates/${stem}.html`);

  // Update existing template HTML.
  const updated = await post(server.base, '/api/templates/save', {
    path: created.data.path,
    html: '<p>Updated {{name}} <img src="cid:badge"><a href="{{unsubscribe_url}}">u</a></p>',
  });
  assert.equal(updated.status, 200);

  // Upload valid PNG asset and verify read + preview embed.
  const pngBytes = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64');
  const uploaded = await post(server.base, '/api/templates/assets', {
    template: created.data.path,
    filename: 'badge.png',
    dataBase64: `data:image/png;base64,${pngBytes}`,
  });
  assert.equal(uploaded.status, 201);
  assert.equal(uploaded.data.cid, 'badge');
  assert.equal(uploaded.data.filename, 'badge.png');

  const readBack = await get(server.base, '/api/templates/read?path=' + encodeURIComponent(created.data.path));
  assert.equal(readBack.status, 200);
  assert.match(readBack.data.html, /Updated \{\{name\}\}/);
  assert.equal(readBack.data.assets.length, 1);
  assert.equal(readBack.data.assets[0].cid, 'badge');

  const preview = await post(server.base, '/api/preview', { csv: CSV, html: created.data.path, subject: 'Hi' });
  assert.equal(preview.status, 200);
  assert.equal(preview.data.inline, 1);

  // Duplicate template + its assets; reject duplicate target name with 409.
  const dup = await post(server.base, '/api/templates/duplicate', { path: created.data.path, name: copyStem });
  assert.equal(dup.status, 201);
  assert.equal(dup.data.path, `templates/${copyStem}.html`);
  assert.equal(existsSync(join(ROOT, 'templates', `${copyStem}-assets`, 'badge.png')), true);
  assert.equal((await post(server.base, '/api/templates/duplicate', { path: created.data.path, name: copyStem })).status, 409);

  // Delete single asset, then delete templates (removing asset folder too).
  const rmAsset = await post(server.base, '/api/templates/assets/delete', { template: created.data.path, filename: 'badge.png' });
  assert.equal(rmAsset.status, 200);
  assert.equal(existsSync(join(ROOT, 'templates', `${stem}-assets`, 'badge.png')), false);

  assert.equal((await post(server.base, '/api/templates/delete', { path: dup.data.path })).status, 200);
  assert.equal(existsSync(join(ROOT, 'templates', `${copyStem}.html`)), false);
  assert.equal(existsSync(join(ROOT, 'templates', `${copyStem}-assets`)), false);
  assert.equal((await post(server.base, '/api/templates/delete', { path: created.data.path })).status, 200);

  // Reject path traversal, dotfile/dot-segment names, invalid asset extensions, empty HTML, and symlinks.
  for (const badName of ['.hidden', '../evil', 'bad/name', '..']) {
    assert.equal((await post(server.base, '/api/templates/save', { name: badName, html: '<p>x</p>' })).status, 400, badName);
  }
  assert.equal((await post(server.base, '/api/templates/save', { name: stem, html: '   ' })).status, 400);
  assert.equal((await post(server.base, '/api/templates/save', { name: stem, html: '<p>x</p>' })).status, 201);
  assert.equal((await post(server.base, '/api/templates/assets', { template: `templates/${stem}.html`, filename: 'evil.svg', dataBase64: pngBytes })).status, 400);
  assert.equal((await post(server.base, '/api/templates/assets', { template: `templates/${stem}.html`, filename: '.dot.png', dataBase64: pngBytes })).status, 400);
  assert.equal((await post(server.base, '/api/templates/assets/delete', { template: `templates/${stem}.html`, filename: '.dot.png' })).status, 400);

  const symPath = join(ROOT, 'templates', `sym-${process.pid}.html`);
  symlinkSync(join(ROOT, 'package.json'), symPath);
  assert.equal((await get(server.base, `/api/templates/read?path=templates/sym-${process.pid}.html`)).status, 400);
  const symAssetsDir = join(ROOT, 'templates', `${stem}-assets`);
  mkdirSync(join(ROOT, 'templates', `ext-dir-${process.pid}`), { recursive: true });
  t.after(() => rmSync(join(ROOT, 'templates', `ext-dir-${process.pid}`), { recursive: true, force: true }));
  symlinkSync(join(ROOT, 'templates', `ext-dir-${process.pid}`), symAssetsDir);
  assert.equal((await post(server.base, '/api/templates/assets', { template: `templates/${stem}.html`, filename: 'ok.png', dataBase64: pngBytes })).status, 400);
});
