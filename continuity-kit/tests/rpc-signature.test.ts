import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  keccak256,
  recoverTransactionAddress,
  serializeTransaction,
} from "viem";
import { rpcQuantity, rpcSignatureScalar } from "../src/sdk/owner-writer.ts";

test("archived Monad v1 quantity signature reconstructs its exact transaction and owner", async () => {
  // No RPC, signing, passkey or storage calls. These are already public bytes.
  const { transaction: tx } = JSON.parse(
    readFileSync(
      new URL("./fixtures/monad-v1-public-transaction.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(tx.s.length, 65); // 63 hex digits: one zero nibble was omitted.
  const envelope = {
    type: "eip1559" as const,
    chainId: Number(rpcQuantity(tx.chainId)),
    nonce: Number(rpcQuantity(tx.nonce)),
    to: tx.to,
    value: rpcQuantity(tx.value),
    data: tx.input,
    gas: rpcQuantity(tx.gas),
    maxFeePerGas: rpcQuantity(tx.maxFeePerGas),
    maxPriorityFeePerGas: rpcQuantity(tx.maxPriorityFeePerGas),
  };
  const signature = {
    r: rpcSignatureScalar(tx.r),
    s: rpcSignatureScalar(tx.s),
    yParity: Number(rpcQuantity(tx.yParity)),
  };
  const raw = serializeTransaction(envelope, signature);
  assert.equal(keccak256(raw), tx.hash);
  assert.equal(
    (
      await recoverTransactionAddress({ serializedTransaction: raw })
    ).toLowerCase(),
    tx.from,
  );
  assert.equal(rpcSignatureScalar(signature.s), signature.s);
  const changed = serializeTransaction(envelope, {
    ...signature,
    s: rpcSignatureScalar(`0x${(BigInt(tx.s) + 1n).toString(16)}`),
  });
  assert.notEqual(keccak256(changed), tx.hash);
});

test("RPC signature normalization only admits bounded nonzero secp256k1 scalars", () => {
  assert.equal(rpcSignatureScalar("0x1"), `0x${"0".repeat(63)}1`);
  for (const value of [
    undefined,
    null,
    1,
    "",
    "0x",
    "0x0",
    `0x${"0".repeat(64)}`,
    "0x01",
    "0x-1",
    "0xgg",
    "0xA",
    `0x1${"0".repeat(64)}`,
    "0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141",
    `0x${"f".repeat(64)}`,
  ])
    assert.throws(() => rpcSignatureScalar(value), {
      code: "TRANSACTION_EVIDENCE_INVALID",
    });
});
