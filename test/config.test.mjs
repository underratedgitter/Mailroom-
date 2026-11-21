import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configProblems, assertConfig } from '../src/lib/config.mjs';
import { missingSmtpFields, resolveSmtpConfig } from '../src/lib/mailer.mjs';
import { expectStartupFailure } from './helpers/server.mjs';

const dir = () => mkdtempSync(join(tmpdir(), 'mailroom-config-'));

test('a sane environment has no problems', () => {
  const d = dir();
  try {
    assert.deepEqual(configProblems({ GUI_PORT: '4173', SMTP_PORT: '587', SMTP_SECURE: 'false' }, { templatesDir: d }), []);
    assert.deepEqual(configProblems({}, { templatesDir: d }), []);
    assert.deepEqual(configProblems({ GUI_PORT: '0' }, { templatesDir: d }), [], 'port 0 means any free port');
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('a bad port is named with the variable and the value', () => {
  for (const value of ['abc', '-1', '70000', '12.5', '80 80', 'undefined']) {
    const [problem, ...rest] = configProblems({ GUI_PORT: value });
    assert.deepEqual(rest, [], value);
    assert.match(problem, /GUI_PORT/);
    assert.match(problem, /0 to 65535/);
    assert.ok(problem.includes(`"${value}"`), problem);
  }
  const [smtp] = configProblems({ SMTP_PORT: '0' });
  assert.match(smtp, /SMTP_PORT.*1 to 65535/);
});

test('every problem is reported together, not one per restart', () => {
  const problems = configProblems({
    GUI_PORT: 'abc',
    SMTP_PORT: 'x',
    SMTP_SECURE: 'maybe',
    SCHEDULE_GRACE_MS: '-5',
    SCHEDULER_INTERVAL_MS: 'soon',
    SEND_LOG_MAX_BYTES: '10MB',
    SEND_LOG_KEEP: '0',
  });
  assert.equal(problems.length, 7);
  for (const name of ['GUI_PORT', 'SMTP_PORT', 'SMTP_SECURE', 'SCHEDULE_GRACE_MS', 'SCHEDULER_INTERVAL_MS', 'SEND_LOG_MAX_BYTES', 'SEND_LOG_KEEP']) {
    assert.ok(problems.some((p) => p.includes(name)), name);
  }
});

test('a missing or unreadable templates folder is refused with its path', () => {
  const d = dir();
  try {
    const missing = join(d, 'nope');
    const [gone] = configProblems({}, { templatesDir: missing });
    assert.match(gone, /templates folder/i);
    assert.ok(gone.includes(missing));

    const file = join(d, 'file.txt');
    writeFileSync(file, 'x');
    assert.match(configProblems({}, { templatesDir: file })[0], /not a folder/i);

    if (process.getuid?.() !== 0) {
      const sub = mkdtempSync(join(d, 'locked-'));
      chmodSync(sub, 0o000);
      try {
        assert.match(configProblems({}, { templatesDir: sub })[0], /cannot read/i);
      } finally {
        chmodSync(sub, 0o700);
      }
    }
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('assertConfig throws one error listing every problem', () => {
  assert.throws(
    () => assertConfig({ GUI_PORT: 'abc', SMTP_PORT: 'x' }),
    (err) => /Invalid configuration/.test(err.message) && /GUI_PORT/.test(err.message) && /SMTP_PORT/.test(err.message),
  );
  assert.doesNotThrow(() => assertConfig({}));
});

test('missingSmtpFields names what a send needs and a local relay does not', () => {
  assert.deepEqual(missingSmtpFields(resolveSmtpConfig({})), ['SMTP_USER', 'SMTP_PASS']);
  assert.deepEqual(missingSmtpFields(resolveSmtpConfig({ SMTP_USER: 'a@b.co' })), ['SMTP_PASS']);
  assert.deepEqual(missingSmtpFields(resolveSmtpConfig({ SMTP_HOST: 'localhost' })), []);
  assert.deepEqual(missingSmtpFields(resolveSmtpConfig({ SMTP_USER: 'a@b.co', SMTP_PASS: 'x' })), []);
});

test('the server refuses to start on a bad port and says why', async () => {
  const res = await expectStartupFailure({ env: { GUI_PORT: 'abc', SMTP_PORT: '99999' } });
  assert.equal(res.code, 1);
  assert.match(res.output, /Invalid configuration/);
  assert.match(res.output, /GUI_PORT/);
  assert.match(res.output, /SMTP_PORT/);
  assert.doesNotMatch(res.output, /\n\s+at /, 'no stack trace');
});

test('the server refuses to start when the log folder cannot be created', async () => {
  const d = dir();
  try {
    const blocker = join(d, 'blocker');
    writeFileSync(blocker, 'a file, not a folder');
    const res = await expectStartupFailure({ env: { SEND_LOG: join(blocker, 'sent.jsonl') } });
    assert.equal(res.code, 1);
    assert.match(res.output, /log folder/i);
    assert.doesNotMatch(res.output, /\n\s+at /, 'no stack trace');
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});
