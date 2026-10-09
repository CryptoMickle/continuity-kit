import { randomBytes } from 'node:crypto';
import { createSecp256k1SigningSession } from '@category-labs/mera';
import { toViemAccount } from '@category-labs/mera/viem';
import { createPublicClient, createWalletClient, getAddress, hexToBytes, http, sha256, toBytes } from 'viem';
import { generatePrivateKey } from 'viem/accounts';
import { startLocalChain } from '../../chain/harness.mjs';
import { prepareWorkReserve, recoverWorkReserve, WORK_PROTOCOL, WORK_SCHEMA } from '../../sdk/work-reserve.mjs';
import { syntheticAuthenticator } from '../../tests/sdk-authenticator.mjs';

export const CLAIM_CONFIRMATION = 'claim-pre-issued-local-payment';

/** Local reference consumer only. All credentials and encrypted records live in RAM. */
export async function createWorkEntitlementScenario() {
  const config = Object.freeze({
    appId: `fictional-checkout-job-${randomBytes(8).toString('hex')}`,
    originalRpId: 'job-primary.example.localhost',
    recoveryRpId: 'job-reserve.example.localhost',
    derivation: 'synthetic-job-leaf:v1',
  });
  const auth = syntheticAuthenticator(config.originalRpId);
  const credential = auth.add(config.recoveryRpId);
  const setupClient = auth.client(config.recoveryRpId);
  const leaf = hexToBytes(generatePrivateKey());
  const primarySession = createSecp256k1SigningSession({ privateKey: leaf });
  const originalAccount = toViemAccount(primarySession);
  const owner = getAddress(originalAccount.address);
  const records = new Map();
  const recoveredContexts = new Set();
  const events = [];
  let primaryAvailable = true, closed = false, harness;
  const store = {
    async get(locator) { const value = records.get(locator); return value && new Uint8Array(value); },
    async putIfAbsent(locator, bytes) {
      if (records.has(locator)) return false;
      records.set(locator, new Uint8Array(bytes)); return true;
    },
  };
  async function close() {
    if (closed) return;
    closed = true; primaryAvailable = false; primarySession.end(); leaf.fill(0);
    for (const recovered of recoveredContexts) recovered.close();
    for (const bytes of records.values()) bytes.fill(0);
    records.clear(); auth.cleanup();
    await harness?.close();
  }
  try {
    harness = await startLocalChain();
    if (harness.chainId !== 31337 || !/^http:\/\/127\.0\.0\.1:\d+$/.test(harness.rpcUrl)) throw new Error('LOCAL_CHAIN_REQUIRED');
    const chain = {
      id: 31337, name: 'Disposable fictional work entitlement',
      nativeCurrency: { name: 'Synthetic local units', symbol: 'TEST', decimals: 18 },
      rpcUrls: { default: { http: [harness.rpcUrl] } },
    };
    const client = createPublicClient({ chain, transport: http(harness.rpcUrl, { retryCount: 0 }) });
    if (await client.getChainId() !== 31337) throw new Error('LOCAL_CHAIN_REQUIRED');

    // This issue happens before preparation, outage, recovery or editing. The
    // existing contract establishes a fixed beneficiary, not proof of work done.
    const entitlement = await harness.prepareRight(owner);
    events.push('pre-existing-payment-issued');
    const work = Object.freeze({
      schema: WORK_SCHEMA,
      title: 'A calmer checkout — fictional job SN-104',
      client: 'Studio North (fictional)',
      brief: `Finish a calm, accessible checkout copy handoff. The earlier discovery workshop fee is already approved in this local fixture. Its pre-issued right is ${entitlement.id} at ${harness.contractAddress} on disposable chain 31337. Editing or exporting this draft does not earn, issue or approve that payment.`,
      deliverable: 'Address error: Please check your street address.\nOrder confirmation: [unfinished]',
      nextStep: 'Finish the confirmation copy and export it. Collect the already-issued workshop payment only through a separate deliberate account action.',
    });
    const ready = await prepareWorkReserve({
      privateKey: leaf, policy: { ...config, expectedOwner: owner.toLowerCase() },
      recoveryCredential: credential, work, store, webAuthnClient: setupClient,
    });
    events.push('work-and-same-account-reserve-prepared');
    // The prepared encrypted snapshot is the only work/account material retained
    // by the recovery reader. No original leaf, locator or owner is an input.
    leaf.fill(0);
    const bootstrapSalt = hexToBytes(sha256(toBytes(`${WORK_PROTOCOL}/bootstrap\0${config.appId}`)));
    const recoveryCalls = { discovery: 0, account: 0, deniedAccount: 0 };
    let accountActionAllowed = false;
    const freshClient = auth.client(config.recoveryRpId);
    const recoveryClient = {
      createCredential() { throw new Error('NEW_CREDENTIAL_FORBIDDEN'); },
      async getCredential(request) {
        const discovery = Buffer.from(request.prfSalt).equals(Buffer.from(bootstrapSalt));
        if (!discovery && !accountActionAllowed) {
          recoveryCalls.deniedAccount++; throw new Error('ACCOUNT_UNLOCK_NOT_APPROVED');
        }
        if (discovery) recoveryCalls.discovery++; else recoveryCalls.account++;
        return freshClient.getCredential(request);
      },
    };
    return Object.freeze({
      config, owner, work, ready, entitlement, harness, client, chain,
      events: () => [...events],
      recoveryCalls: () => ({ ...recoveryCalls }),
      primary: Object.freeze({
        readWork() { if (!primaryAvailable) throw new Error('SYNTHETIC_PRIMARY_UNAVAILABLE'); return { ...work }; },
        signMessage: options => originalAccount.signMessage(options),
      }),
      takePrimaryOffline() {
        if (closed) throw new Error('SCENARIO_CLOSED');
        primaryAvailable = false; primarySession.end(); events.push('primary-retired-and-signer-closed');
      },
      async recoverWork() {
        if (closed) throw new Error('SCENARIO_CLOSED');
        if (primaryAvailable) throw new Error('TAKE_PRIMARY_OFFLINE_FIRST');
        const readonlyStore = { get: locator => store.get(locator) };
        const recovered = await recoverWorkReserve({ config, store: readonlyStore, webAuthnClient: recoveryClient });
        recoveredContexts.add(recovered); events.push('work-recovered-with-account-locked');
        return recovered;
      },
      async claimPreIssuedPayment(recovered, confirmation) {
        if (closed) throw new Error('SCENARIO_CLOSED');
        if (confirmation !== CLAIM_CONFIRMATION) throw new Error('EXPLICIT_LOCAL_CLAIM_REQUIRED');
        if (!recoveredContexts.has(recovered)) throw new Error('RECOVERED_CONTEXT_REQUIRED');
        // Discovery is read-only and derives the entitlement from the recovered
        // owner, not a saved ID from the original application's session.
        const discovered = await harness.rightForOwner(recovered.owner);
        if (!discovered || getAddress(discovered.beneficiary) !== getAddress(recovered.owner)) throw new Error('PAYMENT_BENEFICIARY_MISMATCH');
        if (discovered.claimed) throw new Error('PAYMENT_ALREADY_CLAIMED');
        let signer;
        accountActionAllowed = true;
        try {
          signer = await recovered.openAccount();
          if (getAddress(signer.account.address) !== getAddress(discovered.beneficiary)) throw new Error('PAYMENT_BENEFICIARY_MISMATCH');
          events.push('same-account-deliberately-unlocked');
          const wallet = createWalletClient({ account: signer.account, chain, transport: http(harness.rpcUrl, { retryCount: 0 }) });
          const balanceBefore = await client.getBalance({ address: signer.account.address });
          const transactionHash = await wallet.writeContract({
            address: harness.contractAddress, abi: harness.abi, functionName: 'claim', args: [discovered.id],
          });
          const receipt = await client.waitForTransactionReceipt({ hash: transactionHash, timeout: 5000 });
          if (receipt.status !== 'success') throw new Error('LOCAL_CLAIM_FAILED');
          const balanceAfter = await client.getBalance({ address: signer.account.address });
          const claim = await harness.claimReceipt(transactionHash);
          events.push('pre-existing-payment-claimed');
          // finally closes this account before the caller receives it. Retain
          // the inert interface so the local verifier can exercise rejection.
          return { discovered, transactionHash, receipt, balanceBefore, balanceAfter, claim, closedAccount: signer.account };
        } finally {
          accountActionAllowed = false; signer?.close(); events.push('account-signing-closed');
        }
      },
      close,
    });
  } catch (error) { await close(); throw error; }
}

/** Plain local export; no account access, RPC or durable reserve update. */
export function finishFictionalHandoff(work) {
  const edited = {
    ...work,
    deliverable: 'Address error: Please check your street address.\nOrder confirmation: Your order is confirmed. We will email the delivery details shortly.',
    nextStep: 'Fictional copy handoff complete; confirm implementation details before real use.',
  };
  return { work: edited, json: JSON.stringify(edited, null, 2) + '\n', text: `${edited.title}\n${edited.client}\n\n${edited.brief}\n\n${edited.deliverable}\n\n${edited.nextStep}\n` };
}
