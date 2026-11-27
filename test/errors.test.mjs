import test from 'node:test';
import assert from 'node:assert/strict';
import {
  errMsg,
  errCode,
  errStatus,
  httpError,
  badRequest,
  forbidden,
  conflict,
} from '../src/lib/errors.mjs';

test('errMsg extracts Error.message and stringifies other values', () => {
  assert.equal(errMsg(new Error('boom')), 'boom');
  assert.equal(errMsg(Object.assign(new TypeError('bad type'), { code: 'ERR' })), 'bad type');
  assert.equal(errMsg('plain string'), 'plain string');
  assert.equal(errMsg(42), '42');
  assert.equal(errMsg(null), 'null');
  assert.equal(errMsg(undefined), 'undefined');
  assert.equal(errMsg({ message: 'not an Error' }), '[object Object]');
});

test('errCode returns string err.code and ignores non-objects or non-string codes', () => {
  assert.equal(errCode(Object.assign(new Error('no file'), { code: 'ENOENT' })), 'ENOENT');
  assert.equal(errCode({ code: 'EADDRINUSE' }), 'EADDRINUSE');
  assert.equal(errCode(new Error('plain')), undefined);
  assert.equal(errCode({ code: 123 }), undefined);
  assert.equal(errCode(null), undefined);
  assert.equal(errCode('ENOENT'), undefined);
});

test('errStatus returns numeric err.status and ignores non-objects or non-numeric statuses', () => {
  assert.equal(errStatus(Object.assign(new Error('nope'), { status: 403 })), 403);
  assert.equal(errStatus({ status: 409 }), 409);
  assert.equal(errStatus(new Error('plain')), undefined);
  assert.equal(errStatus({ status: '400' }), undefined);
  assert.equal(errStatus(null), undefined);
});

test('HTTP error helpers construct Error instances with the expected status and message', () => {
  const custom = httpError(413, 'Too big');
  assert.ok(custom instanceof Error);
  assert.equal(custom.status, 413);
  assert.equal(custom.message, 'Too big');

  assert.equal(badRequest('Bad input').status, 400);
  assert.equal(badRequest('Bad input').message, 'Bad input');
  assert.equal(forbidden('Read-only').status, 403);
  assert.equal(conflict('Exists').status, 409);
});
