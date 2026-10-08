import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomNonce, validHandoff } from '../handoff.mjs';

function ceremony() {
  const source = {};
  const expected = {
    origin: 'http://continuity-reserve.localhost:4574',
    source,
    nonce: randomNonce(),
    phase: 'waiting',
    expiresAt: 2000,
  };
  const event = {
    origin: expected.origin,
    source,
    data: { version: 1, kind: 'receive', nonce: expected.nonce },
  };
  return { expected, event };
}

test('only the intended popup at the exact reserve origin can request the handover', (t) => {
  t.mock.method(Date, 'now', () => 1000);
  const { expected, event } = ceremony();
  assert.equal(validHandoff(event, expected, 'receive'), true);
  for (const origin of [
    'http://continuity-reserve.localhost:4575',
    'https://continuity-reserve.localhost:4574',
    'http://continuity-reserve.localhost.evil.example:4574',
    'http://continuity-primary.localhost:4573',
    'null',
  ]) {
    assert.equal(validHandoff({ ...event, origin }, expected, 'receive'), false, origin);
  }
  assert.equal(validHandoff({ ...event, source: {} }, expected, 'receive'), false, 'another same-origin window');
  assert.equal(validHandoff({ ...event, source: null }, expected, 'receive'), false, 'missing source');
});

test('a nonce from another user action cannot replay a handover request', (t) => {
  t.mock.method(Date, 'now', () => 1000);
  const first = ceremony();
  const second = ceremony();
  assert.notEqual(first.expected.nonce, second.expected.nonce);
  const replay = { ...second.event, data: { ...second.event.data, nonce: first.expected.nonce } };
  assert.equal(validHandoff(replay, second.expected, 'receive'), false);
  for (const nonce of ['', undefined, first.expected.nonce.slice(1)]) {
    assert.equal(validHandoff({ ...first.event, data: { ...first.event.data, nonce } }, first.expected, 'receive'), false);
  }
});

test('a consumed or closed ceremony rejects even the exact previously accepted event', (t) => {
  t.mock.method(Date, 'now', () => 1000);
  const { expected, event } = ceremony();
  assert.equal(validHandoff(event, expected, 'receive'), true);
  // The caller consumes the ceremony before transferring the key. The validator
  // must not reopen it merely because the message still has a valid nonce.
  for (const phase of ['transferred', 'ready', 'closed', undefined]) {
    expected.phase = phase;
    assert.equal(validHandoff(event, expected, 'receive'), false, String(phase));
  }
});

test('the deadline is enforced at the boundary without waiting for a timer callback', (t) => {
  let now = 1999;
  t.mock.method(Date, 'now', () => now);
  const { expected, event } = ceremony();
  assert.equal(validHandoff(event, expected, 'receive'), true);
  now = 2000;
  assert.equal(validHandoff(event, expected, 'receive'), false, 'exact deadline');
  now = 9000;
  assert.equal(validHandoff(event, expected, 'receive'), false, 'delayed timeout callback');
});

test('message confusion and extra fields cannot turn a window message into a key handover', (t) => {
  t.mock.method(Date, 'now', () => 1000);
  const { expected, event } = ceremony();
  const rejected = [
    undefined, null, '', 1, [], {},
    { ...event.data, version: '1' },
    { ...event.data, version: 2 },
    { ...event.data, kind: 'prepared' },
    { ...event.data, kind: 'channel' },
    { ...event.data, origin: expected.origin },
    { ...event.data, privateKey: new Uint8Array(32) },
    { version: 1, kind: 'receive' },
  ];
  for (const data of rejected) {
    assert.equal(validHandoff({ ...event, data }, expected, 'receive'), false);
  }
  const channel = { ...event, data: { ...event.data, kind: 'channel' } };
  assert.equal(validHandoff(channel, expected, 'channel'), true);
  assert.equal(validHandoff(event, expected, 'channel'), false);
});

test('handover nonces contain 32 bytes and are generated independently', () => {
  const nonces = Array.from({ length: 8 }, () => randomNonce());
  for (const nonce of nonces) assert.match(nonce, /^[a-f0-9]{64}$/);
  assert.equal(new Set(nonces).size, nonces.length);
});
