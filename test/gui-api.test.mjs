import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CSV, startServer, post } from './helpers/server.mjs';

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
