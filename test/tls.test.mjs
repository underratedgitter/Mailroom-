import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, expectStartupFailure, post, get } from './helpers/server.mjs';

/** A throwaway self-signed certificate for the TLS test. */
function selfSignedCert() {
  const dir = mkdtempSync(join(tmpdir(), 'mailroom-cert-'));
  const cert = join(dir, 'cert.pem');
  const key = join(dir, 'key.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost',
  ], { stdio: 'ignore' });
  return { dir, cert, key };
}

test('plain HTTP on loopback still serves the app', async (t) => {
  const server = await startServer();
  t.after(server.stop);

  assert.match(server.base, /^http:\/\//);
  assert.equal((await get(server.base, '/')).status, 200);
});

test('a non-loopback plain-HTTP bind is refused without an opt-out', async () => {
  const result = await expectStartupFailure({ env: { GUI_HOST: '0.0.0.0' } });

  assert.equal(result.code, 1);
  assert.match(result.output, /Refusing to serve Mailroom over plain HTTP on 0\.0\.0\.0/);
  assert.match(result.output, /MAILROOM_TLS_CERT/);
  assert.match(result.output, /MAILROOM_ALLOW_INSECURE=1/);
});

test('the insecure opt-out allows a non-loopback HTTP bind', async (t) => {
  const server = await startServer({
    env: { GUI_HOST: '0.0.0.0', MAILROOM_ALLOW_INSECURE: '1', MAILROOM_PASSWORD: 'secret-pass' },
  });
  t.after(server.stop);

  assert.equal((await get(server.base, '/api/health')).status, 200);
});

test('HTTPS serves the app and marks the session cookie Secure', async (t) => {
  const { dir, cert, key } = selfSignedCert();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // Trust the throwaway certificate for this test process only. The server
  // child never needs this: it is the one presenting the certificate.
  const previous = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  t.after(() => {
    if (previous === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previous;
  });

  const server = await startServer({
    env: {
      MAILROOM_TLS_CERT: cert,
      MAILROOM_TLS_KEY: key,
      MAILROOM_PASSWORD: 'secret-pass',
    },
  });
  t.after(server.stop);

  assert.match(server.base, /^https:\/\//);
  assert.equal((await get(server.base, '/login.html')).status, 200);

  const login = await post(server.base, '/api/login', { password: 'secret-pass' });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie');
  assert.match(cookie, /mr_session=/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /; Secure/);

  const session = cookie.split(';')[0];
  assert.equal((await get(server.base, '/api/state', { cookie: session })).status, 200);
});
