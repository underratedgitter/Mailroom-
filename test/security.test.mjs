import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, expectStartupFailure, post, get, wait } from './helpers/server.mjs';
import { hashPassword, verifyPassword } from '../src/lib/auth.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = join(ROOT, 'public');

/** A request with a hand-picked Host header, which fetch() will not allow. */
function rawRequest(port, { method = 'GET', path = '/api/state', headers = {}, body = null }) {
  return new Promise((resolveDone, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      res.resume();
      res.on('end', () => resolveDone({ status: res.statusCode, headers: res.headers }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

// ── Password storage ─────────────────────────────────────────────────
test('passwords are stored as salted scrypt hashes and verified exactly', async () => {
  const first = await hashPassword('correct horse');
  const second = await hashPassword('correct horse');

  assert.match(first, /^scrypt:\d+:\d+:\d+:[\w-]+:[\w-]+$/);
  assert.notEqual(first, second, 'each hash carries its own salt');
  assert.doesNotMatch(first, /correct horse/);

  assert.equal(await verifyPassword('correct horse', first), true);
  assert.equal(await verifyPassword('correct horsf', first), false);
  assert.equal(await verifyPassword('', first), false);
  assert.equal(await verifyPassword('correct horse', first.slice(0, -4)), false);
});

test('the hash command turns a password from stdin into a config line', async (t) => {
  const run = spawnSync(process.execPath, [join(ROOT, 'src/lib/auth.mjs')], {
    input: 'from-stdin\n', encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stderr);
  const line = run.stdout.trim();
  assert.match(line, /^MAILROOM_PASSWORD_HASH=scrypt:/);
  assert.doesNotMatch(run.stdout, /from-stdin/);

  const server = await startServer({ env: { MAILROOM_PASSWORD_HASH: line.split('=')[1] } });
  t.after(server.stop);
  assert.equal((await post(server.base, '/api/login', { password: 'from-stdin' })).status, 200);
  assert.equal((await post(server.base, '/api/login', { password: 'from-stdin\n' })).status, 401);
});

test('MAILROOM_PASSWORD_HASH gates the app and wins over a plaintext password', async (t) => {
  const hash = await hashPassword('hashed-pass');
  const server = await startServer({
    env: { MAILROOM_PASSWORD_HASH: hash, MAILROOM_PASSWORD: 'plain-pass' },
  });
  t.after(server.stop);

  assert.equal((await get(server.base, '/api/state')).status, 401);
  assert.equal((await post(server.base, '/api/login', { password: 'plain-pass' })).status, 401);
  assert.equal((await post(server.base, '/api/login', { password: 'x'.repeat(5000) })).status, 401);
  assert.equal((await post(server.base, '/api/login', { password: 'hashed-pass' })).status, 200);
  assert.doesNotMatch(server.output(), /hashed-pass|plain-pass/);
});

test('a plaintext MAILROOM_PASSWORD still works but is flagged for migration', async (t) => {
  const server = await startServer({ env: { MAILROOM_PASSWORD: 'legacy-pass' } });
  t.after(server.stop);

  assert.equal((await post(server.base, '/api/login', { password: 'legacy-pass' })).status, 200);
  assert.equal((await post(server.base, '/api/login', { password: 'legacy-pas' })).status, 401);
  assert.equal((await post(server.base, '/api/login', { password: 'legacy-passX' })).status, 401);
});

test('a malformed MAILROOM_PASSWORD_HASH refuses to start instead of opening the app', async () => {
  const result = await expectStartupFailure({ env: { MAILROOM_PASSWORD_HASH: 'plaintext-by-mistake' } });

  assert.equal(result.code, 1);
  assert.match(result.output, /MAILROOM_PASSWORD_HASH/);
  assert.doesNotMatch(result.output, /plaintext-by-mistake/);
});

test('a non-loopback bind accepts a hash as its password', async (t) => {
  const server = await startServer({
    env: {
      GUI_HOST: '0.0.0.0', MAILROOM_ALLOW_INSECURE: '1', MAILROOM_PASSWORD_HASH: await hashPassword('lan-pass'),
    },
  });
  t.after(server.stop);
  assert.equal((await post(server.base, '/api/login', { password: 'lan-pass' })).status, 200);
});

// ── Sessions and cookies ─────────────────────────────────────────────
test('the session cookie is HttpOnly, SameSite=Strict and expires with the session', async (t) => {
  const server = await startServer({ env: { MAILROOM_PASSWORD: 'secret-pass', MAILROOM_SESSION_TTL_SECONDS: '3600' } });
  t.after(server.stop);

  const login = await post(server.base, '/api/login', { password: 'secret-pass' });
  const cookie = login.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Path=\//);
  assert.match(cookie, /Max-Age=3600/);
  assert.doesNotMatch(cookie, /Secure/, 'loopback HTTP cannot carry a Secure cookie');
});

test('a session stops working once its lifetime has passed', async (t) => {
  const server = await startServer({ env: { MAILROOM_PASSWORD: 'secret-pass', MAILROOM_SESSION_TTL_SECONDS: '1' } });
  t.after(server.stop);

  const login = await post(server.base, '/api/login', { password: 'secret-pass' });
  const session = login.headers.get('set-cookie').split(';')[0];
  assert.equal((await get(server.base, '/api/state', { cookie: session })).status, 200);

  await wait(1300);
  assert.equal((await get(server.base, '/api/state', { cookie: session })).status, 401);
});

test('logout destroys the session on the server and clears the cookie', async (t) => {
  const server = await startServer({ env: { MAILROOM_PASSWORD: 'secret-pass' } });
  t.after(server.stop);

  const login = await post(server.base, '/api/login', { password: 'secret-pass' });
  const session = login.headers.get('set-cookie').split(';')[0];

  const logout = await post(server.base, '/api/logout', {}, { cookie: session });
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);

  // Replaying the old token (as a thief would) must not work.
  assert.equal((await get(server.base, '/api/state', { cookie: session })).status, 401);
});

test('logging in again retires the session that was presented', async (t) => {
  const server = await startServer({ env: { MAILROOM_PASSWORD: 'secret-pass' } });
  t.after(server.stop);

  const first = (await post(server.base, '/api/login', { password: 'secret-pass' })).headers.get('set-cookie').split(';')[0];
  const second = (await post(server.base, '/api/login', { password: 'secret-pass' }, { cookie: first })).headers.get('set-cookie').split(';')[0];

  assert.notEqual(first, second);
  assert.equal((await get(server.base, '/api/state', { cookie: first })).status, 401);
  assert.equal((await get(server.base, '/api/state', { cookie: second })).status, 200);
});

test('behind a trusted proxy the cookie is Secure only for HTTPS requests', async (t) => {
  const env = {
    GUI_HOST: '0.0.0.0', MAILROOM_ALLOW_INSECURE: '1', MAILROOM_PASSWORD: 'secret-pass', MAILROOM_TRUST_PROXY: '1',
  };
  const server = await startServer({ env });
  t.after(server.stop);

  const login = (forwarded) => post(server.base, '/api/login', { password: 'secret-pass' }, forwarded ? { 'x-forwarded-proto': forwarded } : {});
  assert.match((await login('https')).headers.get('set-cookie'), /; Secure/);
  assert.match((await login('https, http')).headers.get('set-cookie'), /; Secure/);
  assert.doesNotMatch((await login('http')).headers.get('set-cookie'), /Secure/);
  assert.doesNotMatch((await login(null)).headers.get('set-cookie'), /Secure/);
});

test('X-Forwarded-Proto is ignored unless a proxy is trusted', async (t) => {
  const server = await startServer({ env: { MAILROOM_PASSWORD: 'secret-pass' } });
  t.after(server.stop);

  const login = await post(server.base, '/api/login', { password: 'secret-pass' }, { 'x-forwarded-proto': 'https' });
  assert.doesNotMatch(login.headers.get('set-cookie'), /Secure/);
  const state = await get(server.base, '/api/state', { 'x-forwarded-proto': 'https' });
  assert.equal(state.headers.get('strict-transport-security'), null);
});

test('login attempts are throttled per client', async (t) => {
  const server = await startServer({ env: { MAILROOM_PASSWORD: 'secret-pass' } });
  t.after(server.stop);

  for (let i = 0; i < 8; i++) assert.equal((await post(server.base, '/api/login', { password: 'bad' })).status, 401);
  assert.equal((await post(server.base, '/api/login', { password: 'secret-pass' })).status, 429);
});

// ── CSRF ─────────────────────────────────────────────────────────────
test('state-changing requests marked cross-site by the browser are refused', async (t) => {
  const server = await startServer();
  t.after(server.stop);

  const send = (site) => post(server.base, '/api/preview', {}, site ? { 'sec-fetch-site': site } : {});
  for (const site of ['cross-site', 'same-site']) {
    const res = await send(site);
    assert.equal(res.status, 403, site);
    assert.match(res.data.error, /cross-site/i);
  }
  // A same-origin page, a typed URL and a non-browser client all pass the gate.
  for (const site of ['same-origin', 'none', null]) assert.notEqual((await send(site)).status, 403, String(site));
  // Reads are not state-changing.
  assert.equal((await get(server.base, '/api/state', { 'sec-fetch-site': 'cross-site' })).status, 200);
});

test('a site cannot log in or log out a visitor cross-site', async (t) => {
  const server = await startServer({ env: { MAILROOM_PASSWORD: 'secret-pass' } });
  t.after(server.stop);

  const forged = { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' };
  assert.equal((await post(server.base, '/api/login', { password: 'secret-pass' }, forged)).status, 403);
  assert.equal((await post(server.base, '/api/logout', {}, forged)).status, 403);
});

test('the page may post from the hostname it was served on, and no other', async (t) => {
  const server = await startServer({
    env: { GUI_HOST: '0.0.0.0', MAILROOM_ALLOW_INSECURE: '1', MAILROOM_PASSWORD: 'secret-pass' },
  });
  t.after(server.stop);

  const post = (host, origin) => rawRequest(server.port, {
    method: 'POST', path: '/api/login',
    headers: { host, origin, 'content-type': 'application/json' }, body: '{}',
  });
  const own = `mail.example.test:${server.port}`;

  assert.notEqual((await post(own, `https://${own}`)).status, 403);
  assert.equal((await post(own, 'https://evil.example')).status, 403);
  assert.equal((await post(own, 'null')).status, 403);
});

// ── Headers and CSP ──────────────────────────────────────────────────
test('every response carries the security headers, including errors and redirects', async (t) => {
  const server = await startServer({ env: { MAILROOM_PASSWORD: 'secret-pass' } });
  t.after(server.stop);

  for (const path of ['/login.html', '/api/state', '/', '/api/health', '/nope']) {
    const { headers } = await get(server.base, path);
    assert.equal(headers.get('x-content-type-options'), 'nosniff', path);
    assert.equal(headers.get('x-frame-options'), 'DENY', path);
    assert.equal(headers.get('referrer-policy'), 'no-referrer', path);
    assert.equal(headers.get('cross-origin-opener-policy'), 'same-origin', path);
    assert.equal(headers.get('cross-origin-resource-policy'), 'same-origin', path);
    assert.match(headers.get('permissions-policy'), /camera=\(\)/, path);
    assert.ok(headers.get('content-security-policy'), path);
  }
});

function csp(header) {
  const directives = new Map();
  for (const part of header.split(';')) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (name) directives.set(name, values);
  }
  return directives;
}

test('the CSP locks scripts to our own files and forbids framing and plugins', async (t) => {
  const server = await startServer();
  t.after(server.stop);

  const policy = csp((await get(server.base, '/')).headers.get('content-security-policy'));
  assert.deepEqual(policy.get('default-src'), ["'none'"]);
  assert.deepEqual(policy.get('script-src'), ["'self'"]);
  assert.deepEqual(policy.get('connect-src'), ["'self'"]);
  assert.deepEqual(policy.get('frame-ancestors'), ["'none'"]);
  assert.deepEqual(policy.get('base-uri'), ["'none'"]);
  assert.deepEqual(policy.get('form-action'), ["'self'"]);
  assert.deepEqual(policy.get('object-src'), ["'none'"]);
  // The sandboxed preview is a srcdoc frame, which inherits this policy: the
  // email's own <style> blocks and inlined images must still render in it.
  assert.ok(policy.get('style-src').includes("'unsafe-inline'"));
  assert.ok(policy.get('img-src').includes('data:'));
});

test('the pages need nothing the CSP forbids', () => {
  for (const name of ['index.html', 'login.html']) {
    const html = readFileSync(join(PUBLIC, name), 'utf8');
    for (const script of html.matchAll(/<script\b([^>]*)>/gi)) assert.match(script[1], /\bsrc="\/[^"]+"/, `${name}: inline script`);
    assert.doesNotMatch(html, /<style\b/i, `${name}: inline <style>`);
    assert.doesNotMatch(html, /\son[a-z]+\s*=/i, `${name}: inline event handler`);
    assert.doesNotMatch(html, /\sstyle\s*=/i, `${name}: style attribute`);
    assert.doesNotMatch(html, /javascript:/i, `${name}: javascript: URL`);
  }
  assert.match(readFileSync(join(PUBLIC, 'index.html'), 'utf8'), /<iframe[^>]*\bsandbox=""/);
});

test('the login page works under the CSP: its script and styles are served files', async (t) => {
  const server = await startServer({ env: { MAILROOM_PASSWORD: 'secret-pass' } });
  t.after(server.stop);

  const page = await get(server.base, '/login.html');
  const assets = [...page.data.matchAll(/(?:src|href)="(\/[^"]+\.(?:js|css))"/g)].map((m) => m[1]);
  assert.ok(assets.some((a) => a.endsWith('.js')) && assets.some((a) => a.endsWith('.css')));
  for (const asset of assets) assert.equal((await get(server.base, asset)).status, 200, asset);
});

test('HSTS is sent only on requests that arrived over HTTPS', async (t) => {
  const server = await startServer({
    env: { GUI_HOST: '0.0.0.0', MAILROOM_ALLOW_INSECURE: '1', MAILROOM_PASSWORD: 'secret-pass', MAILROOM_TRUST_PROXY: '1' },
  });
  t.after(server.stop);

  const secure = await get(server.base, '/login.html', { 'x-forwarded-proto': 'https' });
  assert.match(secure.headers.get('strict-transport-security'), /max-age=\d+/);
  assert.equal((await get(server.base, '/login.html')).headers.get('strict-transport-security'), null);
});

// ── Binding ──────────────────────────────────────────────────────────
test('with no GUI_HOST the server listens on loopback only', async (t) => {
  const server = await startServer({ env: { GUI_HOST: undefined } });
  t.after(server.stop);

  const external = Object.values(networkInterfaces()).flat().find((i) => i && !i.internal && i.family === 'IPv4');
  assert.equal((await get(server.base, '/api/health')).status, 200);
  if (!external) return t.skip('no external IPv4 interface to probe');

  const refused = await new Promise((resolveDone) => {
    const sock = net.connect(server.port, external.address);
    sock.on('connect', () => { sock.destroy(); resolveDone(false); });
    sock.on('error', () => resolveDone(true));
  });
  assert.equal(refused, true, 'reachable from a non-loopback address');
});
