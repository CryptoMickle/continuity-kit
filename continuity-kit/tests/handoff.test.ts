import test from "node:test";
import assert from "node:assert/strict";
import { HandoffChannel } from "../src/handoff.ts";

function setup() {
  let time = 1000;
  const a = {},
    b = {};
  const queue: { target: "a" | "b"; data: unknown }[] = [];
  const A = new HandoffChannel({
    role: "primary",
    peer: b,
    origin: "http://recovery.localhost:4174",
    send: (data) => queue.push({ target: "b", data }),
    now: () => time,
    nonce: () => "a".repeat(64),
  });
  const B = new HandoffChannel({
    role: "recovery",
    peer: a,
    origin: "http://primary.localhost:4173",
    send: (data) => queue.push({ target: "a", data }),
    now: () => time,
    nonce: () => "b".repeat(64),
  });
  const deliver = () => {
    const m = queue.shift()!;
    return m.target === "a"
      ? A.accept({
          origin: "http://recovery.localhost:4174",
          source: b,
          data: m.data,
        })
      : B.accept({
          origin: "http://primary.localhost:4173",
          source: a,
          data: m.data,
        });
  };
  return {
    A,
    B,
    a,
    b,
    queue,
    deliver,
    advance: () => {
      time += 300001;
    },
  };
}
test("handoff accepts exactly one ordered exchange bound to both nonces and the actual peer", () => {
  const { A, B, queue, deliver } = setup();
  A.setOffer({ synthetic: "fixture" });
  B.ready();
  deliver();
  const replay = queue[0]!;
  assert.deepEqual(deliver(), {
    kind: "offer",
    payload: { synthetic: "fixture" },
  });
  queue.push(replay);
  assert.equal(deliver(), null);
  assert.throws(() => B.backup({}));
  B.begin();
  assert.deepEqual(deliver(), { kind: "begin", payload: undefined });
  A.grant({ key: "synthetic" });
  assert.deepEqual(deliver(), { kind: "grant", payload: { key: "synthetic" } });
  assert.throws(() => B.begin());
  assert.throws(() => A.grant({}));
  B.backup({ sealed: "bytes" });
  assert.deepEqual(deliver(), { kind: "backup", payload: { sealed: "bytes" } });
  A.committed({ version: "1" });
  assert.deepEqual(deliver(), { kind: "committed", payload: { version: "1" } });
  assert.throws(() => B.backup({}));
  assert.throws(() => A.committed({}));
});
test("a stale creation request cannot release a key after expiry or into a new channel", () => {
  const old = setup();
  old.A.setOffer({ context: "public-only" });
  old.B.ready();
  old.deliver();
  old.deliver();
  old.B.begin();
  const request = old.queue.shift()!;
  old.advance();
  assert.equal(
    old.A.accept({
      origin: "http://recovery.localhost:4174",
      source: old.b,
      data: request.data,
    }),
    null,
  );
  assert.throws(() => old.A.grant({ key: "must-not-send" }));
  assert.equal(old.queue.length, 0);
  const fresh = setup();
  fresh.A.setOffer({ context: "public-only" });
  assert.equal(
    fresh.A.accept({
      origin: "http://recovery.localhost:4174",
      source: old.b,
      data: request.data,
    }),
    null,
  );
  assert.equal(fresh.queue.length, 0);
});
test("wrong origin, source, reordered message and expired sessions cannot deliver a key", () => {
  const { A, B, b, queue, advance, deliver } = setup();
  A.setOffer({ secret: "synthetic" });
  B.ready();
  const ready = queue.shift()!.data;
  assert.equal(
    A.accept({ origin: "http://evil.localhost:4174", source: b, data: ready }),
    null,
  );
  assert.equal(
    A.accept({
      origin: "http://recovery.localhost:4174",
      source: {},
      data: ready,
    }),
    null,
  );
  assert.equal(queue.length, 0);
  assert.throws(() => B.backup({}));
  advance();
  queue.push({ target: "a", data: ready });
  assert.equal(deliver(), null);
  assert.equal(queue.length, 0);
});
