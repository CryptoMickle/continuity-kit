import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";
import { createLocalService } from "../scripts/service.mjs";
import { LOCAL_POLICY } from "../src/sdk/policy.ts";
import {
  registryDomain,
  registrySigningMessage,
} from "../src/sdk/registry-signing.ts";
const account = privateKeyToAccount(`0x${"01".repeat(32)}`); // Public disposable test fixture, never funded.
const hash = (bytes) => `0x${createHash("sha256").update(bytes).digest("hex")}`;

test("HTTP model verifies owner signatures and CAS while rejecting another origin", async () => {
  const service = await createLocalService({ port: 0 });
  const url = `http://localhost:${service.port}`;
  try {
    const request = async (
      command,
      signature,
      domain = registryDomain(LOCAL_POLICY),
    ) =>
      fetch(`${url}/v1/registry`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...command,
          domain,
          signature:
            signature ??
            (await account.signMessage({
              message: registrySigningMessage(LOCAL_POLICY, command),
            })),
        }),
      });
    const command = {
      operation: "create",
      owner: account.address.toLowerCase(),
      streamId: hash("stream"),
      manifestDigest: hash("manifest"),
      initialCapsuleDigest: hash("v1"),
    };
    assert.equal((await request(command, "0x00")).status, 403);
    assert.equal(
      (
        await request(command, undefined, {
          ...registryDomain(LOCAL_POLICY),
          deploymentId: "foreign-deployment",
        })
      ).status,
      403,
    );
    assert.equal((await request(command)).status, 200);
    assert.equal((await request(command)).status, 409);
    const commit = {
      operation: "commit",
      owner: command.owner,
      streamId: command.streamId,
      expectedVersion: "1",
      expectedDigest: command.initialCapsuleDigest,
      nextDigest: hash("v2"),
    };
    const results = await Promise.all([request(commit), request(commit)]);
    assert.deepEqual(results.map((x) => x.status).sort(), [200, 409]);
    const head = await (
      await fetch(`${url}/v1/registry/${command.owner}/${command.streamId}`)
    ).json();
    assert.equal(head.version, "2");
    assert.equal(head.evidence.trustMode, "local-model");
    const hostile = await fetch(`${url}/v1/control`, {
      method: "POST",
      headers: {
        origin: "https://attacker.example",
        "content-type": "application/json",
      },
      body: '{"scenario":"missing-current"}',
    });
    assert.equal(hostile.status, 403);
  } finally {
    await service.close();
  }
});
test("HTTP mirrors preserve exact immutable bytes and reject incorrect content digests", async () => {
  const service = await createLocalService({ port: 0 });
  const url = `http://localhost:${service.port}/v1/mirrors/0`;
  try {
    const bytes = Buffer.from('{"ciphertext":"synthetic-encrypted-fixture"}');
    const put = (path, body) =>
      fetch(`${url}/${path}`, {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body,
      });
    assert.equal((await put(`blob/${hash("wrong")}`, bytes)).status, 400);
    assert.equal((await put(`blob/${hash(bytes)}`, bytes)).status, 200);
    assert.deepEqual(
      Buffer.from(
        await (await fetch(`${url}/blob/${hash(bytes)}`)).arrayBuffer(),
      ),
      bytes,
    );
    assert.equal((await put("index/fixture", bytes)).status, 200);
    assert.equal((await put("index/fixture", bytes)).status, 200);
    assert.equal(
      (await put("index/fixture", Buffer.from("different"))).status,
      409,
    );
  } finally {
    await service.close();
  }
});
