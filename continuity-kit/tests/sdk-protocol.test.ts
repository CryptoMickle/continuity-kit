import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MeraPasskeyAdapter,
  LOCAL_POLICY,
  createPrimary,
  prepareBackup,
  finalizeEnrollment,
  saveCheckpoint,
  discoverRecovery,
  recoverCurrent,
  restorePrimary,
  MemoryMirrorStore,
  MemoryRegistry,
  ContinuityError,
  createLocalCopy,
  exportLocalCopy,
  validatePolicy,
  ScopedOwnerSession,
  encryptCapsule,
  deriveOwnerSession,
} from "../src/sdk/index.ts";
import type {
  Workspace,
  Adapters,
  RecoveryPolicy,
  Hex,
} from "../src/sdk/index.ts";
import { SyntheticWebAuthnClient } from "../src/sdk/demo-fixture.ts";
import {
  canonical,
  bytesOf,
  parseCanonical,
  lookupKeys,
  open,
  seal,
  digest,
  unb64,
  b64,
  hex,
} from "../src/sdk/crypto.ts";
const workspace: Workspace = {
  title: "Synthetic workspace",
  plan: "Only public synthetic test content",
  tasks: [{ id: "task-1", text: "Keep encrypted copies", done: false }],
  draft: "Version one",
};
let sequence = 0;
async function setup(options: { fallback?: boolean } = {}) {
  const seed = "SYNTHETIC SDK FIXTURE " + sequence++;
  const client = new SyntheticWebAuthnClient({
    seed,
    fallbackOnCreate: options.fallback,
  });
  const passkeys = new MeraPasskeyAdapter(client);
  const mirrors = [
    new MemoryMirrorStore("mirror-0"),
    new MemoryMirrorStore("mirror-1"),
  ];
  const registry = new MemoryRegistry();
  const adapters: Adapters = { mirrors, registry };
  const primary = await createPrimary(LOCAL_POLICY, passkeys);
  const backup = await prepareBackup(LOCAL_POLICY, passkeys, primary);
  const state = await finalizeEnrollment(primary, backup, workspace, adapters);
  return { seed, client, passkeys, mirrors, registry, adapters, state, backup };
}
const code = (expected: string) => (e: unknown) =>
  e instanceof ContinuityError && e.code === expected;
async function freshB(s: Awaited<ReturnType<typeof setup>>) {
  const fixture = new SyntheticWebAuthnClient({ seed: s.seed });
  const passkeys = new MeraPasskeyAdapter(fixture);
  const d = await discoverRecovery(LOCAL_POLICY, passkeys, s.adapters);
  const recovered = await recoverCurrent(d, passkeys, s.adapters);
  return { recovered, fixture };
}
test("actual Mera vault: fresh B recovers with exactly two synthetic assertions, no A credential request", async () => {
  const s = await setup();
  const result = await freshB(s);
  assert.deepEqual(result.recovered.content, workspace);
  assert.equal(result.recovered.evidence.trustMode, "local-model");
  assert.deepEqual(result.fixture.ceremonies, [
    { operation: "get", rpId: LOCAL_POLICY.bRpId, pinned: false },
    { operation: "get", rpId: LOCAL_POLICY.bRpId, pinned: true },
  ]);
  s.state.close();
});
test("fresh A reconstructs same owner, full workspace, scoped signer and next checkpoint without B", async () => {
  const s = await setup();
  const owner = s.state.context.owner;
  s.state.close();
  const fixture = new SyntheticWebAuthnClient({ seed: s.seed });
  const result = await restorePrimary(
    LOCAL_POLICY,
    new MeraPasskeyAdapter(fixture),
    s.adapters,
  );
  assert.equal(result.state.context.owner, owner);
  assert.deepEqual(result.recovered.content, workspace);
  assert.equal(fixture.ceremonies.length, 1);
  assert.equal(fixture.ceremonies[0].rpId, LOCAL_POLICY.aRpId);
  const saved = await saveCheckpoint(
    result.state,
    { ...workspace, draft: "After fresh A login" },
    s.adapters,
  );
  assert.equal(saved.version, "2");
  result.state.close();
});
test("correct v1 replay at requested v2 is rejected; second mirror succeeds; both replay yields unavailable", async () => {
  const s = await setup();
  const first = s.state.enrollment!.capsuleBytes;
  await saveCheckpoint(
    s.state,
    { ...workspace, draft: "Version two" },
    s.adapters,
  );
  s.mirrors[0].readBlobHook = () => first;
  const result = await freshB(s);
  assert.equal(result.recovered.version, "2");
  assert.equal(result.recovered.content.draft, "Version two");
  assert.equal(result.recovered.diagnostics[0].code, "DIGEST_MISMATCH");
  s.mirrors[1].readBlobHook = () => first;
  await assert.rejects(() => freshB(s), code("CURRENT_DATA_UNAVAILABLE"));
  s.state.close();
});
test("missing current bytes never opens older valid content", async () => {
  const s = await setup();
  const head = await saveCheckpoint(
    s.state,
    { ...workspace, draft: "v2" },
    s.adapters,
  );
  s.mirrors.forEach((m) => m.blobs.delete(head.capsuleDigest));
  await assert.rejects(() => freshB(s), code("CURRENT_DATA_UNAVAILABLE"));
  s.state.close();
});
test("offline registry fails closed even with authentic index and capsule", async () => {
  const s = await setup();
  s.registry.offline = true;
  await assert.rejects(() => freshB(s), code("FRESHNESS_UNAVAILABLE"));
  s.state.close();
});
test("tampered manifest mirror does not suppress healthy mirror", async () => {
  const s = await setup();
  s.mirrors[0].readIndexHook = () =>
    bytesOf({
      format: "continuity-index-envelope/v1",
      nonce: b64(new Uint8Array(12)),
      ciphertext: b64(new Uint8Array(32)),
    });
  assert.deepEqual((await freshB(s)).recovered.content, workspace);
  s.mirrors[1].readIndexHook = s.mirrors[0].readIndexHook;
  await assert.rejects(() => freshB(s), code("MANIFEST_INVALID"));
  s.state.close();
});
test("wrong passkey and missing indexes produce honest absence, not a claim of key loss", async () => {
  const s = await setup();
  const passkeys = new MeraPasskeyAdapter(
    new SyntheticWebAuthnClient({ seed: "wrong fixture" }),
  );
  await assert.rejects(
    () => discoverRecovery(LOCAL_POLICY, passkeys, s.adapters),
    code("NO_RECOVERY_MATERIAL"),
  );
  s.mirrors.forEach((m) => m.indexes.delete(s.backup.locator));
  await assert.rejects(() => freshB(s), code("NO_RECOVERY_MATERIAL"));
  s.state.close();
});
test("unsupported PRF and user cancellation remain distinct controlled errors; no credential created on construction", async () => {
  const client = new SyntheticWebAuthnClient({ seed: "failurefixture" });
  const passkeys = new MeraPasskeyAdapter(client);
  assert.equal(client.ceremonies.length, 0);
  client.prfUnavailable = true;
  await assert.rejects(
    () => passkeys.openPrimary(LOCAL_POLICY),
    code("PRF_UNAVAILABLE"),
  );
  client.prfUnavailable = false;
  client.cancelNext = true;
  await assert.rejects(
    () => passkeys.openPrimary(LOCAL_POLICY),
    code("AUTH_CANCELLED"),
  );
});
test("Mera fallback is measured as extra assertion and still restores", async () => {
  const s = await setup({ fallback: true });
  assert.equal(
    s.client.ceremonies.filter((c) => c.operation === "create").length,
    2,
  );
  assert.equal(
    s.client.ceremonies.filter((c) => c.operation === "get").length,
    3,
  );
  assert.equal((await freshB(s)).recovered.version, "1");
  s.state.close();
});
test("strict canonical parser rejects duplicate keys, unknown numeric domain, noncanonical bytes and oversized data", () => {
  for (const raw of [
    '{"x":1,"x":1}',
    '{ "x":1 }',
    '{"x":2}',
    '{"x":"\\ud800"}',
  ])
    assert.throws(
      () => parseCanonical(new TextEncoder().encode(raw), 1000),
      code("SCHEMA_INVALID"),
    );
  assert.throws(
    () => parseCanonical(bytesOf({ value: "large" }), 3),
    code("SCHEMA_INVALID"),
  );
  assert.throws(() => unb64("AB"), code("SCHEMA_INVALID"));
  assert.throws(() => canonical({ number: NaN }), code("SCHEMA_INVALID"));
});
test("nested unknown vault fields and authenticated context substitutions fail before foreign credential prompt", async () => {
  const s = await setup();
  const result = await s.passkeys.discover(
    LOCAL_POLICY,
    s.backup.manifest.vault.credential.credentialId,
  );
  const keys = await lookupKeys(result.prfOutput);
  const aad = {
    format: "continuity-index/v1",
    bootstrapNamespace: LOCAL_POLICY.bootstrapNamespace,
    bRpId: LOCAL_POLICY.bRpId,
    locator: keys.locator,
  };
  const modified = structuredClone(s.backup.manifest) as unknown as {
    vault: Record<string, unknown>;
  };
  modified.vault.extra = "forbidden";
  const bytes = bytesOf({
    format: "continuity-index-envelope/v1",
    ...(await seal(keys.key, bytesOf(modified), aad)),
  });
  s.mirrors.forEach((m) => m.indexes.set(keys.locator, bytes));
  const before = s.client.ceremonies.length;
  await assert.rejects(
    () => discoverRecovery(LOCAL_POLICY, s.passkeys, s.adapters),
    code("MANIFEST_INVALID"),
  );
  assert.equal(s.client.ceremonies.length, before + 1);
  s.state.close();
});
test("different authenticated manifests at same locator cause enrollment conflict, never first-mirror selection", async () => {
  const s = await setup();
  const result = await s.passkeys.discover(
    LOCAL_POLICY,
    s.backup.manifest.vault.credential.credentialId,
  );
  const keys = await lookupKeys(result.prfOutput);
  const altered = structuredClone(s.backup.manifest);
  altered.context.streamId = `0x${"ab".repeat(32)}`;
  const aad = {
    format: "continuity-index/v1",
    bootstrapNamespace: LOCAL_POLICY.bootstrapNamespace,
    bRpId: LOCAL_POLICY.bRpId,
    locator: keys.locator,
  };
  s.mirrors[1].indexes.set(
    keys.locator,
    bytesOf({
      format: "continuity-index-envelope/v1",
      ...(await seal(keys.key, bytesOf(altered), aad)),
    }),
  );
  await assert.rejects(() => freshB(s), code("ENROLLMENT_CONFLICT"));
  s.state.close();
});
test("primary authenticated record wrong owner fails fresh restoration", async () => {
  const s = await setup();
  const index = s.state.enrollment!.primaryBytes;
  const box = parseCanonical(index, 65536) as {
    nonce: string;
    ciphertext: string;
  };
  const aad = {
    format: "continuity-primary-index/v1",
    aRpId: LOCAL_POLICY.aRpId,
    applicationId: LOCAL_POLICY.applicationId,
    locator: s.state.locator,
  };
  const raw = parseCanonical(await open(s.state.recordKey, box, aad), 8192) as {
    context: { owner: Hex };
  };
  raw.context.owner = `0x${"ab".repeat(20)}`;
  const altered = bytesOf({
    format: "continuity-primary-envelope/v1",
    ...(await seal(s.state.recordKey, bytesOf(raw), aad)),
  });
  s.mirrors.forEach((m) => m.indexes.set(s.state.locator, altered));
  await assert.rejects(
    () => restorePrimary(LOCAL_POLICY, s.passkeys, s.adapters),
    code("MANIFEST_INVALID"),
  );
  s.state.close();
});
test("registry immutable manifest mismatch rejects valid encrypted content", async () => {
  const s = await setup();
  const head = s.registry.heads.get(
    s.state.context.owner + s.state.context.streamId,
  )!;
  head.manifestDigest = `0x${"ab".repeat(32)}`;
  await assert.rejects(() => freshB(s), code("MANIFEST_BINDING_MISMATCH"));
  s.state.close();
});
test("two concurrent checkpoint writers use CAS; exactly one succeeds", async () => {
  const s = await setup();
  const results = await Promise.allSettled([
    saveCheckpoint(s.state, { ...workspace, draft: "writer 1" }, s.adapters),
    saveCheckpoint(s.state, { ...workspace, draft: "writer 2" }, s.adapters),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const failed = results.find(
    (r) => r.status === "rejected",
  ) as PromiseRejectedResult;
  assert.equal(failed.reason.code, "WRITE_CONFLICT");
  assert.equal((await freshB(s)).recovered.version, "2");
  s.state.close();
});
test("storage failure prevents owner commit, retry reuses exact enrollment bytes", async () => {
  const s = await setup();
  const prior = await s.registry.getHead(
    LOCAL_POLICY,
    s.state.context.owner,
    s.state.context.streamId,
  );
  s.mirrors[1].offline = true;
  await assert.rejects(
    () =>
      saveCheckpoint(s.state, { ...workspace, draft: "unsaved" }, s.adapters),
    code("STORAGE_FAILED"),
  );
  s.mirrors[1].offline = false;
  assert.equal(
    (
      await s.registry.getHead(
        LOCAL_POLICY,
        s.state.context.owner,
        s.state.context.streamId,
      )
    ).capsuleDigest,
    prior.capsuleDigest,
  );
  const exact = s.state.enrollment!.primaryBytes;
  await finalizeEnrollment(s.state, s.backup, workspace, s.adapters);
  assert.equal(s.state.enrollment!.primaryBytes, exact);
  s.state.close();
});
test("B data-key possession cannot authorize a forged capsule as current", async () => {
  const s = await setup();
  const forged = await encryptCapsule(
    s.state.context,
    s.backup.manifestDigest,
    s.state.dataKey,
    "1",
    { ...workspace, draft: "forged" },
  );
  s.mirrors.forEach((m) => {
    m.readBlobHook = () => forged.bytes;
  });
  await assert.rejects(() => freshB(s), code("CURRENT_DATA_UNAVAILABLE"));
  s.state.close();
});
test("head advance during recovery is retried and returned content matches final accepted version", async () => {
  const s = await setup();
  const oldGet = s.registry.getHead.bind(s.registry);
  let calls = 0;
  s.registry.getHead = async (...args) => {
    calls++;
    if (calls === 3) {
      s.registry.getHead = oldGet;
      await saveCheckpoint(
        s.state,
        { ...workspace, draft: "advanced while recovering" },
        s.adapters,
      );
    }
    return oldGet(...args);
  };
  const result = await freshB(s);
  assert.equal(result.recovered.version, "2");
  assert.equal(result.recovered.content.draft, "advanced while recovering");
  s.state.close();
});
test("session expiry, explicit close, owner and stream scope prevent signing", async () => {
  const s = await setup();
  const command = {
    operation: "commit" as const,
    owner: s.state.context.owner,
    streamId: s.state.context.streamId,
    expectedVersion: "1",
    expectedDigest: s.state.enrollment!.capsuleDigest,
    nextDigest: `0x${"ab".repeat(32)}` as Hex,
  };
  await assert.rejects(
    () =>
      s.state.session.sign({ ...command, streamId: `0x${"cd".repeat(32)}` }),
    code("CONTEXT_MISMATCH"),
  );
  s.state.close();
  await assert.rejects(
    () => saveCheckpoint(s.state, workspace, s.adapters),
    code("SESSION_EXPIRED"),
  );
  const session = new ScopedOwnerSession(new Uint8Array(32).fill(7), 1);
  session.bindContext({ ...s.state.context, owner: session.owner });
  await new Promise((resolve) => setTimeout(resolve, 5));
  await assert.rejects(
    () => session.sign({ ...command, owner: session.owner }),
    code("SESSION_EXPIRED"),
  );
});
test("local copies preserve source evidence and make no registry writes", async () => {
  const s = await setup();
  const recovered = (await freshB(s)).recovered;
  const copy = createLocalCopy(recovered);
  copy.content.draft = "local edited draft";
  const exported = JSON.parse(exportLocalCopy(copy));
  assert.equal(exported.status, "local-working-copy");
  assert.equal(exported.source.version, "1");
  assert.equal(recovered.content.draft, "Version one");
  assert.equal((await freshB(s)).recovered.version, "1");
  s.state.close();
});
test("policy rejects nested RP authority and silently promoted production/testnet authority", () => {
  assert.throws(
    () =>
      validatePolicy({
        ...LOCAL_POLICY,
        aRpId: "localhost",
        aOrigin: "http://localhost:4173",
      }),
    code("POLICY_INVALID"),
  );
  assert.throws(
    () =>
      validatePolicy({
        ...LOCAL_POLICY,
        trustMode: "rpc-quorum",
      } as unknown as RecoveryPolicy),
    code("POLICY_INVALID"),
  );
});
test("purpose-separated locator/encryption key domains and fixed independent mapping vector", async () => {
  const input = new Uint8Array(32).fill(42);
  const a = await lookupKeys(input, true),
    b = await lookupKeys(input, false);
  assert.notEqual(a.locator, b.locator);
  assert.notDeepEqual(a.key, b.key);
  assert.notEqual(await digest(a.key), await digest(b.key));
  assert.equal(a.locator, "dZvr_qjgSe4ZwoOQGWjHsPiTEWU65utkp3kOrw05E3E");
  assert.equal(
    hex(a.key),
    "0x96533ed89596f01775f54ce05ec667f19df5ea315440acd552d3404a3a37ca42",
  );
  const session = deriveOwnerSession(input);
  assert.equal(session.owner, "0xb63b33315674e004adb9c64a7477207841894c97");
  session.close();
});
test("fixed conformance vector independently matches viem account and Node HKDF/framing", async () => {
  const { createHash, hkdfSync } = await import("node:crypto");
  const { mnemonicToAccount } = await import("viem/accounts");
  const { entropyToMnemonic } = await import("@scure/bip39");
  const { wordlist } = await import("@scure/bip39/wordlists/english.js");
  const prf = new Uint8Array(32).fill(42);
  const salt = createHash("sha256").update("continuity-kit/v1/hkdf").digest();
  const lookup = Buffer.from(
    hkdfSync("sha256", prf, salt, "primary-locator", 32),
  );
  const key = Buffer.from(
    hkdfSync("sha256", prf, salt, "primary-record-aes-gcm", 32),
  );
  const locator = createHash("sha256")
    .update("continuity-kit/v1/primary-locator\0")
    .update(lookup)
    .digest("base64url");
  const actual = await lookupKeys(prf, true);
  assert.equal(actual.locator, locator);
  assert.equal(hex(actual.key), "0x" + key.toString("hex"));
  const expected = mnemonicToAccount(entropyToMnemonic(prf, wordlist), {
    path: "m/44'/60'/0'/0/0",
  }).address.toLowerCase();
  const session = deriveOwnerSession(prf);
  assert.equal(session.owner, expected);
  session.close();
});
test("registry evidence regressing between two equal heads fails closed", async () => {
  const s = await setup();
  const original = s.registry.getHead.bind(s.registry);
  let reads = 0;
  s.registry.getHead = async (...args) => {
    const head = await original(...args);
    head.evidence.blockNumber = ++reads < 3 ? "9" : "8";
    head.evidence.blockHash = `0x${"ab".repeat(32)}`;
    return head;
  };
  await assert.rejects(() => freshB(s), code("FRESHNESS_UNAVAILABLE"));
  s.state.close();
});
test("continuous accepted head advances end with bounded HEAD_MOVED", async () => {
  const s = await setup();
  const original = s.registry.getHead.bind(s.registry);
  let suppress = false;
  let calls = 0;
  s.registry.getHead = async (...args) => {
    if (!suppress && ++calls >= 3) {
      suppress = true;
      try {
        await saveCheckpoint(
          s.state,
          { ...workspace, draft: `Advance ${calls}` },
          s.adapters,
        );
      } finally {
        suppress = false;
      }
    }
    return original(...args);
  };
  await assert.rejects(() => freshB(s), code("HEAD_MOVED"));
  s.state.close();
});
test("immutable A enrollment cannot be rebound even with a second new B passkey", async () => {
  const s = await setup();
  const other = await prepareBackup(LOCAL_POLICY, s.passkeys, s.state);
  await assert.rejects(
    () => finalizeEnrollment(s.state, other, workspace, s.adapters),
    code("ENROLLMENT_CONFLICT"),
  );
  assert.equal(
    (await freshB(s)).recovered.manifestDigest,
    s.backup.manifestDigest,
  );
  s.state.close();
});
test("storage hides a previously authenticated alternate enrollment: stateless lookup cannot discover hidden history", async () => {
  const s = await setup();
  const evaluated = await s.passkeys.discover(
    LOCAL_POLICY,
    s.backup.manifest.vault.credential.credentialId,
  );
  const keys = await lookupKeys(evaluated.prfOutput);
  const alternate = structuredClone(s.backup.manifest);
  alternate.context.streamId = `0x${"ac".repeat(32)}`;
  const aad = {
    format: "continuity-index/v1",
    bootstrapNamespace: LOCAL_POLICY.bootstrapNamespace,
    bRpId: LOCAL_POLICY.bRpId,
    locator: keys.locator,
  };
  const hidden = bytesOf({
    format: "continuity-index-envelope/v1",
    ...(await seal(keys.key, bytesOf(alternate), aad)),
  });
  assert.notDeepEqual(hidden, s.backup.indexBytes);
  assert.equal(
    (await freshB(s)).recovered.manifestDigest,
    s.backup.manifestDigest,
  );
  s.state.close();
});
test("backup selected credential mismatch is rejected before vault unwrap", async () => {
  const s = await setup();
  const evaluated = await s.passkeys.discover(
    LOCAL_POLICY,
    s.backup.manifest.vault.credential.credentialId,
  );
  const keys = await lookupKeys(evaluated.prfOutput);
  const altered = structuredClone(s.backup.manifest);
  altered.vault = {
    ...altered.vault,
    credential: {
      ...altered.vault.credential,
      credentialId: b64(new Uint8Array(32).fill(9)),
    },
  };
  const aad = {
    format: "continuity-index/v1",
    bootstrapNamespace: LOCAL_POLICY.bootstrapNamespace,
    bRpId: LOCAL_POLICY.bRpId,
    locator: keys.locator,
  };
  const bytes = bytesOf({
    format: "continuity-index-envelope/v1",
    ...(await seal(keys.key, bytesOf(altered), aad)),
  });
  s.mirrors.forEach((m) => m.indexes.set(keys.locator, bytes));
  const fixture = new SyntheticWebAuthnClient({ seed: s.seed });
  await assert.rejects(
    () =>
      discoverRecovery(
        LOCAL_POLICY,
        new MeraPasskeyAdapter(fixture),
        s.adapters,
      ),
    code("MANIFEST_INVALID"),
  );
  assert.equal(fixture.ceremonies.length, 1);
  s.state.close();
});
test("expired session after async upload cannot submit a registry commit", async () => {
  const s = await setup();
  const original = s.mirrors[0].putBlob.bind(s.mirrors[0]);
  s.mirrors[0].putBlob = async (...args) => {
    await original(...args);
    s.state.session.close();
  };
  await assert.rejects(
    () =>
      saveCheckpoint(
        s.state,
        { ...workspace, draft: "closed during storage" },
        s.adapters,
      ),
    code("SESSION_EXPIRED"),
  );
  assert.equal(
    (
      await s.registry.getHead(
        LOCAL_POLICY,
        s.state.context.owner,
        s.state.context.streamId,
      )
    ).version,
    "1",
  );
  s.state.close();
});
test("owner signatures are bound to every fixed deployment context field", async () => {
  const { registrySigningMessage } = await import("../src/sdk/index.ts");
  const { recoverMessageAddress } = await import("viem");
  const s = await setup();
  const command = {
    operation: "commit" as const,
    owner: s.state.context.owner,
    streamId: s.state.context.streamId,
    expectedVersion: "1",
    expectedDigest: s.state.enrollment!.capsuleDigest,
    nextDigest: `0x${"ab".repeat(32)}` as Hex,
  };
  const signature = await s.state.session.sign(command);
  assert.equal(
    (
      await recoverMessageAddress({
        message: registrySigningMessage(LOCAL_POLICY, command),
        signature,
      })
    ).toLowerCase(),
    command.owner,
  );
  const replacements = {
    deploymentId: "another-local-deployment",
    chainId: "31338",
    registryAddress: `0x${"ab".repeat(20)}` as Hex,
    registryCodeHash: `0x${"ab".repeat(32)}` as Hex,
    applicationId: "another-app",
    schemaId: "another-schema",
    aOrigin: "http://alternate.localhost:4173",
    bOrigin: "http://alternate.localhost:4174",
    aRpId: "alternate.localhost",
    bRpId: "alternate.localhost",
    protocol: "other-protocol",
  };
  for (const [field, value] of Object.entries(replacements)) {
    const policy = { ...LOCAL_POLICY, [field]: value };
    assert.notEqual(
      (
        await recoverMessageAddress({
          message: registrySigningMessage(policy, command),
          signature,
        })
      ).toLowerCase(),
      command.owner,
      field,
    );
  }
  const otherPolicy = { ...LOCAL_POLICY, deploymentId: "other-local-model" };
  await assert.rejects(
    () =>
      new MemoryRegistry(otherPolicy).execute(otherPolicy, command, signature),
    code("CONTEXT_MISMATCH"),
  );
  assert.equal(
    (await s.registry.getHead(LOCAL_POLICY, command.owner, command.streamId))
      .version,
    "1",
  );
  s.state.close();
});
test("session copies its deployment scope and rejects caller-injected signing domains", async () => {
  const { registrySigningMessage } = await import("../src/sdk/index.ts");
  const { recoverMessageAddress } = await import("viem");
  const s = await setup();
  const command = {
    operation: "commit" as const,
    owner: s.state.context.owner,
    streamId: s.state.context.streamId,
    expectedVersion: "1",
    expectedDigest: s.state.enrollment!.capsuleDigest,
    nextDigest: `0x${"ab".repeat(32)}` as Hex,
  };
  s.state.context.deploymentId = "mutated-after-binding";
  const signature = await s.state.session.sign(command);
  assert.equal(
    (
      await recoverMessageAddress({
        message: registrySigningMessage(LOCAL_POLICY, command),
        signature,
      })
    ).toLowerCase(),
    command.owner,
  );
  await assert.rejects(
    () =>
      s.state.session.sign({
        ...command,
        domain: { chainId: "1" },
      } as typeof command),
    code("SCHEMA_INVALID"),
  );
  s.state.close();
});
test("save snapshots caller content before storage awaits and returns the exact encrypted content", async () => {
  const s = await setup();
  const edited = structuredClone(workspace);
  edited.draft = "Captured before save";
  const original = s.mirrors[0].putBlob.bind(s.mirrors[0]);
  s.mirrors[0].putBlob = async (...args) => {
    edited.draft = "Caller changed draft during upload";
    edited.tasks[0].done = true;
    await original(...args);
  };
  const saved = await saveCheckpoint(s.state, edited, s.adapters);
  const recovered = (await freshB(s)).recovered;
  assert.equal(saved.content.draft, "Captured before save");
  assert.equal(saved.content.tasks[0].done, false);
  assert.deepEqual(saved.content, recovered.content);
  assert.notDeepEqual(saved.content, edited);
  s.state.close();
});
test("initial enrollment snapshots caller content before manifest hashing and uploads", async () => {
  const seed = "initial-snapshot-fixture";
  const passkeys = new MeraPasskeyAdapter(
    new SyntheticWebAuthnClient({ seed }),
  );
  const mirrors = [
    new MemoryMirrorStore("mirror-0"),
    new MemoryMirrorStore("mirror-1"),
  ];
  const adapters = { mirrors, registry: new MemoryRegistry() };
  const primary = await createPrimary(LOCAL_POLICY, passkeys);
  const backup = await prepareBackup(LOCAL_POLICY, passkeys, primary);
  const content = structuredClone(workspace);
  const pending = finalizeEnrollment(primary, backup, content, adapters);
  content.draft = "Changed immediately after calling finalize";
  const state = await pending;
  const fresh = new MeraPasskeyAdapter(new SyntheticWebAuthnClient({ seed }));
  const recovered = await recoverCurrent(
    await discoverRecovery(LOCAL_POLICY, fresh, adapters),
    fresh,
    adapters,
  );
  assert.equal(recovered.content.draft, workspace.draft);
  state.close();
});
test("concurrent identical enrollment shares one immutable cache and later retries succeed", async () => {
  const seed = "concurrent-enrollment-fixture";
  const passkeys = new MeraPasskeyAdapter(
    new SyntheticWebAuthnClient({ seed }),
  );
  const mirrors = [
    new MemoryMirrorStore("mirror-0"),
    new MemoryMirrorStore("mirror-1"),
  ];
  const adapters = { mirrors, registry: new MemoryRegistry() };
  const primary = await createPrimary(LOCAL_POLICY, passkeys);
  const backup = await prepareBackup(LOCAL_POLICY, passkeys, primary);
  const results = await Promise.allSettled([
    finalizeEnrollment(primary, backup, workspace, adapters),
    finalizeEnrollment(primary, backup, workspace, adapters),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 2);
  const cached = primary.enrollment!;
  assert.deepEqual(
    mirrors[0].indexes.get(primary.locator),
    cached.primaryBytes,
  );
  assert.deepEqual(
    mirrors[1].indexes.get(primary.locator),
    cached.primaryBytes,
  );
  assert.deepEqual(
    mirrors[0].blobs.get(cached.capsuleDigest),
    cached.capsuleBytes,
  );
  await finalizeEnrollment(primary, backup, workspace, adapters);
  assert.equal(primary.enrollment, cached);
  assert.equal(
    (
      await adapters.registry.getHead(
        LOCAL_POLICY,
        primary.context.owner,
        primary.context.streamId,
      )
    ).version,
    "1",
  );
  primary.close();
});
test("concurrent differing backup enrollment is rejected before it can replace prepared bytes", async () => {
  const seed = "concurrent-conflicting-fixture";
  const passkeys = new MeraPasskeyAdapter(
    new SyntheticWebAuthnClient({ seed }),
  );
  const adapters = {
    mirrors: [
      new MemoryMirrorStore("mirror-0"),
      new MemoryMirrorStore("mirror-1"),
    ],
    registry: new MemoryRegistry(),
  };
  const primary = await createPrimary(LOCAL_POLICY, passkeys);
  const backup = await prepareBackup(LOCAL_POLICY, passkeys, primary);
  const other = await prepareBackup(LOCAL_POLICY, passkeys, primary);
  const first = finalizeEnrollment(primary, backup, workspace, adapters);
  await assert.rejects(
    () => finalizeEnrollment(primary, other, workspace, adapters),
    code("ENROLLMENT_CONFLICT"),
  );
  await first;
  assert.equal(
    primary.enrollment!.backup.manifestDigest,
    backup.manifestDigest,
  );
  await finalizeEnrollment(primary, backup, workspace, adapters);
  primary.close();
});
