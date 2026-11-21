import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const SEND = resolve(dirname(fileURLToPath(import.meta.url)), '../src/send.mjs');

// Preview mode renders locally and never opens an SMTP connection.
function runPreview(extraArgs) {
  const dir = mkdtempSync(join(tmpdir(), 'mailroom-cli-'));
  try {
    writeFileSync(join(dir, 'r.csv'), 'email,name\na@example.com,Ann\nb@example.com,Bob\n');
    writeFileSync(join(dir, 't.html'), '<p>{{name}}</p>');
    return spawnSync(process.execPath, [
      SEND, '--csv', 'r.csv', '--html', 't.html', '--subject', 'Hi', ...extraArgs,
    ], {
      cwd: dir,
      encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: dir, MAILROOM_CONFIG: join(dir, 'none.env') },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('CLI rejects a non-numeric or negative --delay instead of disabling throttling', () => {
  for (const value of ['abc', '-5', 'NaN', '']) {
    const res = runPreview([`--delay=${value}`]);
    assert.equal(res.status, 1, `--delay "${value}"`);
    assert.match(res.stderr, /--delay must be a whole number of milliseconds/);
  }
});

test('CLI rejects an invalid --limit', () => {
  for (const value of ['abc', '-3', '0', 'NaN']) {
    const res = runPreview([`--limit=${value}`]);
    assert.equal(res.status, 1, `--limit "${value}"`);
    assert.match(res.stderr, /--limit must be a whole number of at least 1/);
  }
});

test('CLI reports a flag value that looks like another option as a plain error', () => {
  const res = runPreview(['--delay', '-5']);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /^\s*Error: .*--delay/);
  assert.doesNotMatch(res.stderr, /\n\s+at /);
});

test('CLI accepts valid numeric flags, including an explicit --delay 0', () => {
  const res = runPreview(['--delay', '0', '--limit', '1']);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /delay\s+0ms between sends/);
  assert.match(res.stdout, /Rendered 1 recipient/);
});
