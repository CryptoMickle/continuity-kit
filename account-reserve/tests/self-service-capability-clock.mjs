import assert from 'node:assert/strict';
import test from 'node:test';
import { validateCapability } from '../self-service/client/config.mjs';

// Fixed API regression tests: database timestamps bound lifetime, while
// performance.now timestamps determine the conservative local deadline.
// Fixtures never issue grants, create passkeys or extend database expiry.
const ISSUED_AT = Date.UTC(2026, 9, 9, 12, 0, 0);
const TTL_MS = 300000;
const DEMO_END = Date.UTC(2026, 10, 10, 0, 0, 0);
const TOKEN = 'A'.repeat(43); // Fictional, canonical 32-byte local fixture.
const iso = milliseconds => new Date(milliseconds).toISOString();
const grant = (overrides = {}) => ({ enrollmentToken: TOKEN, expiresAt: iso(ISSUED_AT + TTL_MS), serverNow: iso(ISSUED_AT + 25), ...overrides });
const timing = (overrides = {}) => ({ requestStartedMs: 1000, responseReceivedMs: 1100, ...overrides });
const rejects = (value, times = timing(), demoEnd = DEMO_END) => assert.throws(() => validateCapability(value, demoEnd, times), error => {
  assert.ok(!String(error?.message).includes(TOKEN), 'failure messages must not contain upload capabilities');
  return true;
});

test('server remaining lifetime minus the full round trip determines the local deadline', () => {
  const checked = validateCapability(grant(), DEMO_END, timing());
  const serverRemainingMs = TTL_MS - 25;
  assert.deepEqual(Object.keys(checked).sort(), ['token', 'until']);
  assert.equal(checked.token, TOKEN);
  assert.equal(checked.until, 1000 + serverRemainingMs);
  assert.equal(checked.until - 1100, serverRemainingMs - 100);
});

for (const skewMs of [-86400000, -300000, -2000, -1, 1, 2000, 300000, 86400000]) {
  test(`device wall-clock skew ${skewMs}ms cannot change a valid grant's local deadline`, t => {
    t.mock.method(Date, 'now', () => ISSUED_AT + skewMs);
    const checked = validateCapability(grant(), DEMO_END, timing());
    assert.equal(checked.until, 1000 + TTL_MS - 25);
  });
}

test('a device clock moving during the request is irrelevant to validation', t => {
  let reads = 0;
  t.mock.method(Date, 'now', () => { reads++; return reads === 1 ? ISSUED_AT - 86400000 : ISSUED_AT + 86400000; });
  const checked = validateCapability(grant(), DEMO_END, timing({ requestStartedMs: 9000, responseReceivedMs: 9050 }));
  assert.equal(checked.until, 9000 + TTL_MS - 25);
  assert.equal(reads, 0, 'this API must not consult the device wall clock');
});

test('zero-origin and fractional monotonic timestamps are valid', () => {
  assert.equal(validateCapability(grant(), DEMO_END, timing({ requestStartedMs: 0, responseReceivedMs: 0.5 })).until, TTL_MS - 25);
  assert.equal(validateCapability(grant(), DEMO_END, timing({ requestStartedMs: 1000.25, responseReceivedMs: 1100.75 })).until, 1000.25 + TTL_MS - 25);
});

test('a full five-minute DB duration is accepted without adding response latency', () => {
  const checked = validateCapability(grant({ serverNow: iso(ISSUED_AT) }), DEMO_END, timing());
  assert.equal(checked.until, 1000 + TTL_MS);
  assert.equal(checked.until - 1100, TTL_MS - 100);
});

test('response latency consuming the whole remaining lifetime is rejected', () => {
  const value = grant({ expiresAt: iso(ISSUED_AT + 100), serverNow: iso(ISSUED_AT) });
  rejects(value, timing());
  rejects(value, timing({ responseReceivedMs: 1101 }));
});

test('a response arriving before its remaining lifetime expires keeps only the unspent time', () => {
  const checked = validateCapability(grant({ expiresAt: iso(ISSUED_AT + 101), serverNow: iso(ISSUED_AT) }), DEMO_END, timing());
  assert.equal(checked.until, 1101);
  assert.equal(checked.until - 1100, 1);
});

test('negative, reversed, nonfinite, missing and nonnumeric request timings are rejected', () => {
  for (const times of [
    undefined, null, {},
    timing({ requestStartedMs: -1 }), timing({ responseReceivedMs: -1 }),
    timing({ requestStartedMs: 1101, responseReceivedMs: 1100 }),
    timing({ requestStartedMs: NaN }), timing({ responseReceivedMs: NaN }),
    timing({ requestStartedMs: Infinity }), timing({ responseReceivedMs: Infinity }),
    timing({ requestStartedMs: '1000' }), timing({ responseReceivedMs: '1100' }),
  ]) assert.throws(() => validateCapability(grant(), DEMO_END, times));
});

test('zero, negative and overlong database durations are rejected', () => {
  rejects(grant({ serverNow: iso(ISSUED_AT + TTL_MS) }));
  rejects(grant({ serverNow: iso(ISSUED_AT + TTL_MS + 1) }));
  rejects(grant({ serverNow: iso(ISSUED_AT - 1) }));
});

test('an already expired DB grant is rejected even when the device clock is slow', t => {
  t.mock.method(Date, 'now', () => ISSUED_AT - 86400000);
  rejects(grant({ serverNow: iso(ISSUED_AT + TTL_MS + 1000) }));
});

test('expiry at the demo deadline is accepted, but beyond it is rejected', () => {
  const value = grant();
  assert.doesNotThrow(() => validateCapability(value, ISSUED_AT + TTL_MS, timing()));
  rejects(value, timing(), ISSUED_AT + TTL_MS - 1);
});

test('DB timestamps must be canonical ISO strings', () => {
  for (const field of ['expiresAt', 'serverNow']) {
    for (const value of [undefined, null, ISSUED_AT, 'not-a-date', '2026-10-09', '2026-10-09T12:00:00Z', '2026-10-09T12:00:00.000+00:00']) rejects(grant({ [field]: value }));
  }
});

test('the response requires exactly the token, DB expiry and DB current-time fields', () => {
  rejects({ enrollmentToken: TOKEN, expiresAt: iso(ISSUED_AT + TTL_MS) });
  rejects(grant({ unrecognized: true }));
  rejects(null);
});

test('malformed and noncanonical upload tokens remain rejected', () => {
  rejects(grant({ enrollmentToken: 'A'.repeat(42) + 'B' }));
  rejects(grant({ enrollmentToken: 'short' }));
  rejects(grant({ enrollmentToken: TOKEN + '=' }));
});
