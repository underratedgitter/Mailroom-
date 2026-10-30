import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startServer, post, get, wait } from './helpers/server.mjs';
import { startSmtpSink } from './helpers/smtp-sink.mjs';

import { CSV } from './helpers/server.mjs';
const TEMPLATE = 'templates/bcci-connect.html';
const FAST = { SCHEDULER_INTERVAL_MS: '100' };

const scheduleBody = (overrides = {}) => ({
  csv: CSV,
  html: TEMPLATE,
  subject: 'Scheduled {{name}}',
  campaign: 'scheduled-test',
  delay: 0,
  ...overrides,
});

async function waitForStatus(base, id, statuses, timeout = 12000) {
  const wanted = new Set([].concat(statuses));
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    const res = await get(base, '/api/schedule');
    last = res.data.entries.find((entry) => entry.id === id);
    if (last && wanted.has(last.status)) return last;
    await wait(150);
  }
  throw new Error(`entry stayed ${last?.status || 'missing'}`);
}

test('a scheduled campaign fires when its time arrives', async (t) => {
  const sink = await startSmtpSink();
  const server = await startServer({ env: FAST });
  t.after(async () => { await server.stop(); await sink.close(); });
  const base = server.base;

  await post(base, '/api/settings', {
    host: '127.0.0.1', port: sink.port, user: 'desk@local.test', pass: 'x',
    from: 'Desk <desk@local.test>',
  });

  const at = new Date(Date.now() + 1200).toISOString();
  const created = await post(base, '/api/schedule', scheduleBody({ at }));
  assert.equal(created.status, 201);
  assert.equal(created.data.entry.status, 'pending');
  assert.equal(created.data.total, 4);

  const done = await waitForStatus(base, created.data.entry.id, ['sent', 'failed']);
  assert.equal(done.status, 'sent');
  assert.deepEqual(done.result, { sent: 4, failed: 0, skipped: 0 });
  assert.equal(sink.messages.length, 4);

  const log = readFileSync(join(server.workDir, 'sent.jsonl'), 'utf8').trim().split('\n');
  assert.equal(log.length, 4);
  assert.ok(log.every((line) => JSON.parse(line).campaign === 'scheduled-test'));
});

test('a schedule survives a restart', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mailroom-sched-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const first = await startServer({ dir });
  const at = new Date(Date.now() + 60_000).toISOString();
  const created = await post(first.base, '/api/schedule', scheduleBody({ at, campaign: 'persisted' }));
  assert.equal(created.status, 201);
  const id = created.data.entry.id;

  await first.stop({ keepData: true });

  const file = join(dir, 'schedule.json');
  assert.equal(existsSync(file), true);
  const stored = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(stored.length, 1);
  assert.equal(stored[0].id, id);
  assert.equal(stored[0].status, 'pending');
  assert.equal(stored[0].recipients.length, 4);

  const second = await startServer({ dir, env: FAST });
  t.after(() => second.stop());
  const list = await get(second.base, '/api/schedule');
  assert.equal(list.data.entries.length, 1);
  assert.equal(list.data.entries[0].id, id);
  assert.equal(list.data.entries[0].status, 'pending');
});

test('a schedule missed by more than the grace window is parked, not sent', async (t) => {
  const sink = await startSmtpSink();
  const dir = mkdtempSync(join(tmpdir(), 'mailroom-missed-'));
  t.after(async () => {
    await sink.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const entry = {
    id: randomUUID(),
    at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
    campaign: 'missed-test',
    subject: 'Too late',
    template: TEMPLATE,
    delay: 0,
    recipients: [{ email: 'a@example.com', name: '', company: '' }],
    status: 'pending',
    error: null,
    result: null,
  };
  writeFileSync(join(dir, 'schedule.json'), JSON.stringify([entry]));

  const server = await startServer({ dir, env: FAST });
  t.after(() => server.stop({ keepData: true }));

  const parked = await waitForStatus(server.base, entry.id, ['missed'], 6000);
  assert.equal(parked.status, 'missed');
  assert.match(parked.error, /not running/i);
  assert.equal(sink.messages.length, 0);
  assert.equal(existsSync(join(dir, 'sent.jsonl')), false);
});

test('an entry left mid-flight by a crash is put back in line after a restart', async (t) => {
  const sink = await startSmtpSink();
  const dir = mkdtempSync(join(tmpdir(), 'mailroom-crash-'));
  t.after(async () => {
    await sink.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // A process that died mid-send leaves the entry marked "sending" with no
  // job behind it; nothing would ever pick it up again.
  const entry = {
    id: randomUUID(),
    at: new Date(Date.now() - 10_000).toISOString(),
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    campaign: 'crash-recovery',
    subject: 'Resumed {{name}}',
    template: TEMPLATE,
    delay: 0,
    recipients: [{ email: 'a@example.com', name: 'A', company: '' }],
    status: 'sending',
    error: null,
    result: null,
  };
  writeFileSync(join(dir, 'schedule.json'), JSON.stringify([entry]));

  const server = await startServer({
    dir,
    env: {
      ...FAST,
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: String(sink.port),
      SMTP_USER: 'desk@local.test',
      SMTP_PASS: 'x',
      SMTP_FROM: 'Desk <desk@local.test>',
    },
  });
  t.after(() => server.stop({ keepData: true }));

  const done = await waitForStatus(server.base, entry.id, ['sent', 'failed']);
  assert.equal(done.status, 'sent');
  assert.equal(done.result.sent, 1);
  assert.equal(sink.messages.length, 1);
  assert.match(String(sink.messages[0].data), /Subject: Resumed A/);
});

test('a pending schedule can be cancelled or run immediately', async (t) => {
  const sink = await startSmtpSink();
  const server = await startServer({ env: FAST });
  t.after(async () => { await server.stop(); await sink.close(); });
  const base = server.base;

  const at = new Date(Date.now() + 60_000).toISOString();
  const cancelled = await post(base, '/api/schedule', scheduleBody({ at, campaign: 'cancel-me' }));
  const cancelledId = cancelled.data.entry.id;
  assert.equal((await post(base, `/api/schedule/${cancelledId}/cancel`, {})).status, 200);
  const afterCancel = await waitForStatus(base, cancelledId, ['cancelled']);
  assert.equal(afterCancel.status, 'cancelled');

  await post(base, '/api/settings', {
    host: '127.0.0.1', port: sink.port, user: 'desk@local.test', pass: 'x',
    from: 'Desk <desk@local.test>',
  });

  const queued = await post(base, '/api/schedule', scheduleBody({ at, campaign: 'run-now' }));
  const queuedId = queued.data.entry.id;
  assert.equal((await post(base, `/api/schedule/${queuedId}/run`, {})).status, 202);

  const done = await waitForStatus(base, queuedId, ['sent', 'failed']);
  assert.equal(done.status, 'sent');
  assert.equal(sink.messages.length, 4);

  // Nothing else was sent for the cancelled campaign.
  const log = readFileSync(join(server.workDir, 'sent.jsonl'), 'utf8');
  assert.equal(log.includes('cancel-me'), false);
  assert.equal(log.includes('run-now'), true);
});

test('the scheduler rejects a time in the past and a missing subject', async (t) => {
  const server = await startServer();
  t.after(server.stop);
  const base = server.base;

  const past = await post(base, '/api/schedule', scheduleBody({ at: new Date(Date.now() - 5000).toISOString() }));
  assert.equal(past.status, 400);

  const noSubject = await post(base, '/api/schedule', scheduleBody({ at: new Date(Date.now() + 60_000).toISOString(), subject: '  ' }));
  assert.equal(noSubject.status, 400);

  const badTime = await post(base, '/api/schedule', scheduleBody({ at: 'tomorrow' }));
  assert.equal(badTime.status, 400);

  const missing = await post(base, `/api/schedule/${randomUUID()}/cancel`, {});
  assert.equal(missing.status, 404);
});
