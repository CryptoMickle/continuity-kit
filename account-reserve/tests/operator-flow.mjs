import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { createPublicClient, http, keccak256, parseEther } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { buildReleaseProposal } from '../deploy/proposal.mjs';
import { createReleaseOperator, operatorProposalHash, OPERATOR_ROLES } from '../deploy/operator.mjs';
import { createFileOperatorJournal } from '../deploy/operator-journal.mjs';

const chain = { id: 10143, name: 'Disposable local operator test', nativeCurrency: { name: 'Local', symbol: 'TEST', decimals: 18 }, rpcUrls: { default: { http: [] } } };
async function localAnvil() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  const child = spawn(join(homedir(), '.foundry/bin/anvil'), ['--host', '127.0.0.1', '--port', String(port), '--chain-id', '10143', '--accounts', '0', '--hardfork', 'paris', '--silent'], { stdio: 'ignore' });
  let spawnError; child.once('error', error => { spawnError = error; });
  const url = `http://127.0.0.1:${port}`;
  let id = 0;
  const rpc = async (method, params = []) => {
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }), signal: AbortSignal.timeout(3000) });
    const result = await response.json(); if (result.error) throw new Error(`${method}: ${result.error.message}`); return result.result;
  };
  const close = async () => {
    if (child.exitCode !== null || child.signalCode !== null || spawnError) return;
    const exit = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 2000); await exit; clearTimeout(timer);
  };
  try {
    for (let i = 0; i < 100; i++) {
      if (spawnError) throw spawnError;
      try { if (await rpc('eth_chainId') === '0x279f') return { url, rpc, close }; } catch {}
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    throw new Error('LOCAL_OPERATOR_ANVIL_NOT_READY');
  } catch (error) { await close(); throw error; }
}

function wrap(client, overrides) { return new Proxy(client, { get(target, key) { return key in overrides ? overrides[key] : target[key]; } }); }

test('bounded operator and adversarial/restart checks use owned loopback Anvil only', async t => {
  const local = await localAnvil(); t.after(local.close);
  const root = await mkdtemp(join(tmpdir(), 'continuity-operator-')); t.after(() => rm(root, { recursive: true, force: true }));
  let fixtureIndex = 0;
  async function fixture({ clientOverrides = () => ({}), signerOverride, journalOverride } = {}) {
    await local.rpc('anvil_reset');
    const issuer = privateKeyToAccount(generatePrivateKey()), beneficiary = privateKeyToAccount(generatePrivateKey());
    const proposal = buildReleaseProposal({ issuer: issuer.address, issuerNonce: '0', beneficiary: beneficiary.address, beneficiaryNonce: '0' });
    const proposalHash = operatorProposalHash(proposal), directory = join(root, String(++fixtureIndex));
    const backing = await createFileOperatorJournal({ directory, proposalHash });
    const counters = { signatures: 0, broadcasts: 0 };
    const journal = journalOverride ? journalOverride(backing) : backing;
    const clients = [0, 1].map(index => {
      const base = createPublicClient({ chain, transport: http(local.url, { retryCount: 0 }), cacheTime: 0 });
      const checked = wrap(base, { async sendRawTransaction(args) {
        counters.broadcasts++;
        const entries = await Promise.all(OPERATOR_ROLES.map(role => backing.read(role)));
        assert.ok(entries.some(entry => entry?.phase === 'signed' && entry.hash === keccak256(args.serializedTransaction)), 'signed hash durable before broadcast');
        return base.sendRawTransaction(args);
      } });
      return wrap(checked, clientOverrides(checked, index));
    });
    const signer = { address: issuer.address, async signTransaction(request) {
      counters.signatures++;
      const role = OPERATOR_ROLES[request.nonce];
      assert.equal((await backing.read(role)).phase, 'reserved', 'durable reservation before signer');
      return signerOverride ? signerOverride(issuer, request) : issuer.signTransaction(request);
    } };
    const endpoints = clients.map(client => ({ url: local.url, client }));
    const approval = { format: 'account-reserve-operator-approval/v1', proposalHash, network: 'local-anvil', rpcUrls: [local.url, local.url], roles: [...OPERATOR_ROLES], expiresAt: new Date(Date.now() + 3600000).toISOString(), approvedByUser: true };
    const options = { proposal, endpoints, signer, journal, network: 'local-anvil' };
    await local.rpc('anvil_setBalance', [issuer.address, `0x${parseEther('1').toString(16)}`]);
    await local.rpc('evm_mine');
    return { operator: createReleaseOperator(options), options, proposal, proposalHash, approval, backing, directory, clients, issuer, beneficiary, counters, async finalize(role) {
      await local.rpc('anvil_mine', ['0x42', '0x0']);
      return createReleaseOperator({ ...options, signer: undefined }).reconcile(role);
    } };
  }

  await t.test('executes exact deploy, funding and issue, then only reads each pinned attempt', async () => {
    const f = await fixture();
    for (const role of OPERATOR_ROLES) {
      const initial = await f.operator.execute({ role, approval: f.approval });
      assert.ok(['finalized', 'awaiting-finality', 'pending-or-unknown'].includes(initial.status), initial.status);
      assert.equal((await f.finalize(role)).status, 'finalized');
      assert.equal((await f.operator.execute({ role })).status, 'finalized', 'existing ticket only reconciles, even without new approval');
    }
    assert.deepEqual(f.counters, { signatures: 3, broadcasts: 3 });
    const restarted = createReleaseOperator({ ...f.options, signer: undefined });
    for (const role of OPERATOR_ROLES) assert.equal((await restarted.reconcile(role)).status, 'finalized');
    assert.equal(await f.clients[0].getBalance({ address: f.proposal.contract.address }), parseEther('0.1'));
    assert.equal(await f.clients[0].getBalance({ address: f.beneficiary.address }), parseEther('0.06'));
    const transactions = await Promise.all(OPERATOR_ROLES.map(async role => {
      const ticket = await f.backing.read(role), receipt = await f.clients[0].getTransactionReceipt({ hash: ticket.hash });
      return { role, hash: ticket.hash, selectedLocalGas: ticket.gas, localGasUsed: receipt.gasUsed.toString(), finalized: true };
    }));
    await writeFile(new URL('../deploy/operator-validation.json', import.meta.url), JSON.stringify({
      status: 'passed-local-operator-setup', executedAt: new Date().toISOString(),
      scope: 'Disposable owned loopback Anvil, Paris hardfork, numeric chain 10143; NOT public Monad',
      implementation: 'deploy/operator.mjs through injected loopback adapters and durable file journal',
      publicRpcRequests: 0, publicTransactions: 0, realFunds: false, physicalPasskeys: false,
      publicRunnerInvoked: false, independentPublicProvidersVerified: false,
      proposalHash: f.proposalHash, artifactSha256: f.proposal.contract.artifactSha256,
      issuer: f.proposal.issuer, beneficiary: f.proposal.beneficiary, contractAddress: f.proposal.contract.address,
      signingCalls: f.counters.signatures, broadcastCalls: f.counters.broadcasts,
      durableReservationBeforeEachSignature: true, exactSignedHashPersistedBeforeEachBroadcast: true,
      restartedReadOnlyReconciliationVerified: true, transactions,
      limitation: 'Two clients use one disposable local Anvil. Public transport factory is separately unit-tested; no live Monad, physical passkey, hosting or public execution evidence is implied.',
    }, null, 2) + '\n');
    for (const file of (await readdir(f.directory)).filter(file => file.endsWith('.json'))) {
      const ticket = JSON.parse(await readFile(join(f.directory, file), 'utf8'));
      assert.deepEqual(Object.keys(ticket).sort(), ['format', 'gas', 'hash', 'phase', 'proposalHash', 'role']);
    }
  });

  await t.test('requires exact proposal-bound approval; local approval cannot authorize public adapters', async () => {
    const f = await fixture();
    for (const approval of [undefined, true, { ...f.approval, approvedByUser: false }, { ...f.approval, proposalHash: 'a'.repeat(64) }, { ...f.approval, network: 'public-testnet' }, { ...f.approval, roles: ['deploy'] }, { ...f.approval, extra: true }]) await assert.rejects(f.operator.execute({ role: 'deploy', approval }), /OPERATOR_EXACT_APPROVAL_REQUIRED/);
    await assert.rejects(f.operator.execute({ role: 'deploy', approval: { ...f.approval, expiresAt: new Date(Date.now() - 1000).toISOString() } }), /OPERATOR_APPROVAL_EXPIRED/);
    assert.throws(() => createReleaseOperator({ ...f.options, network: 'public-testnet' }), /OPERATOR_RPC_NOT_APPROVED/);
    const publicOperator = createReleaseOperator({ ...f.options, network: 'public-testnet', endpoints: f.options.endpoints.map((endpoint, i) => ({ ...endpoint, url: f.proposal.network.rpcCandidates[i] })) });
    await assert.rejects(publicOperator.execute({ role: 'deploy', approval: f.approval }), /OPERATOR_EXACT_APPROVAL_REQUIRED/);
    assert.throws(() => createReleaseOperator({ ...f.options, proposal: { ...f.proposal, budget: { ...f.proposal.budget, maxTransactionCount: 5 } } }), /OPERATOR_PROPOSAL_MISMATCH/);
    await assert.rejects(f.operator.execute({ role: 'issue-fixed-right', approval: f.approval }), /OPERATOR_PREVIOUS_STEP_NOT_FINALIZED/);
    await assert.rejects(f.operator.execute({ role: 'claim-after-prepared-recovery', approval: f.approval }), /OPERATOR_ROLE_NOT_APPROVED/);
    assert.deepEqual(f.counters, { signatures: 0, broadcasts: 0 });
    assert.equal(await f.backing.read('deploy'), undefined);
  });

  const preflightFailures = [
    ['wrong chain', () => ({ getChainId: async () => 1 }), /OPERATOR_CHAIN_MISMATCH/],
    ['wrong actor code', client => ({ getCode: async args => args.address.toLowerCase() === '0x0000000000000000000000000000000000000000' ? client.getCode(args) : '0x6000' }), /OPERATOR_ACTOR_CODE_UNEXPECTED/],
    ['pending nonce', client => ({ getTransactionCount: args => args.blockTag === 'pending' ? 9 : client.getTransactionCount(args) }), /OPERATOR_NONCE_NOT_APPROVED/],
    ['priority cap', () => ({ estimateMaxPriorityFeePerGas: async () => 3000000000n }), /OPERATOR_FEE_CAP_EXCEEDED/],
    ['gas margin exceeds ceiling', () => ({ estimateGas: async () => 900000n }), /OPERATOR_GAS_NOT_APPROVED/],
    ['stale head', client => ({ getBlock: async args => ({ ...await client.getBlock(args), timestamp: 1n }) }), /OPERATOR_STALE_OR_INVALID_HEAD/],
    ['provider block disagreement', (client, i) => i === 1 ? { getBlock: async args => ({ ...await client.getBlock(args), hash: `0x${'42'.repeat(32)}` }) } : {}, /OPERATOR_RPC_HEAD_DISAGREEMENT/],
  ];
  for (const [name, clientOverrides, pattern] of preflightFailures) await t.test(`refuses ${name} before reserving/signing`, async () => {
    const f = await fixture({ clientOverrides });
    await assert.rejects(f.operator.execute({ role: 'deploy', approval: f.approval }), pattern);
    assert.deepEqual(f.counters, { signatures: 0, broadcasts: 0 });
    assert.equal(await f.backing.read('deploy'), undefined);
  });

  await t.test('normal provider head lag is accepted through a shared numbered block', async () => {
    const f = await fixture({ clientOverrides: (client, index) => index === 1 ? { getBlock: async args => {
      const block = await client.getBlock(args);
      return args.blockTag && block.number > 1n ? client.getBlock({ blockNumber: block.number - 1n }) : block;
    } } : {} });
    await local.rpc('anvil_mine', ['0x2', '0x0']);
    await f.operator.execute({ role: 'deploy', approval: f.approval });
    assert.equal((await f.finalize('deploy')).status, 'finalized');
    assert.deepEqual(f.counters, { signatures: 1, broadcasts: 1 });
  });

  await t.test('ordinary block advancement during preflight preserves pinned state reads', async () => {
    let advanced = false;
    const f = await fixture({ clientOverrides: (client, index) => index === 0 ? { getCode: async args => {
      if (!advanced) { advanced = true; await local.rpc('evm_mine'); }
      return client.getCode(args);
    } } : {} });
    await f.operator.execute({ role: 'deploy', approval: f.approval });
    assert.equal((await f.finalize('deploy')).status, 'finalized');
    assert.deepEqual(f.counters, { signatures: 1, broadcasts: 1 });
  });

  for (const [name, signerOverride, error] of [
    ['wrong recovered signer', (_, request) => privateKeyToAccount(generatePrivateKey()).signTransaction(request), /OPERATOR_SIGNED_OWNER_MISMATCH/],
    ['changed calldata', (account, request) => account.signTransaction({ ...request, data: '0x' }), /OPERATOR_TRANSACTION_SCOPE_MISMATCH/],
    ['changed nonce', (account, request) => account.signTransaction({ ...request, nonce: 1 }), /OPERATOR_TRANSACTION_SCOPE_MISMATCH/],
    ['changed fee', (account, request) => account.signTransaction({ ...request, maxFeePerGas: request.maxFeePerGas + 1n }), /OPERATOR_TRANSACTION_SCOPE_MISMATCH/],
    ['signer cancellation', () => { throw new Error('LOCAL_SIGNER_CANCELLED'); }, /LOCAL_SIGNER_CANCELLED/],
  ]) await t.test(`${name} burns exactly one reservation with no broadcast or restart signing`, async () => {
    const f = await fixture({ signerOverride });
    await assert.rejects(f.operator.execute({ role: 'deploy', approval: f.approval }), error);
    assert.equal((await f.backing.read('deploy')).phase, 'reserved');
    assert.equal((await createReleaseOperator(f.options).execute({ role: 'deploy', approval: f.approval })).status, 'blocked-unsigned-attempt');
    assert.deepEqual(f.counters, { signatures: 1, broadcasts: 0 });
  });

  await t.test('lost response after accepted send is reconciled without resending after restart', async () => {
    const f = await fixture({ clientOverrides: client => ({ async sendRawTransaction(args) { await client.sendRawTransaction(args); throw new Error('LOCAL_LOST_RESPONSE'); } }) });
    await assert.rejects(f.operator.execute({ role: 'deploy', approval: f.approval }), /LOCAL_LOST_RESPONSE/);
    assert.equal((await f.backing.read('deploy')).phase, 'signed');
    assert.equal((await f.finalize('deploy')).status, 'finalized');
    assert.equal((await createReleaseOperator(f.options).execute({ role: 'deploy', approval: f.approval })).status, 'finalized');
    assert.deepEqual(f.counters, { signatures: 1, broadcasts: 1 });
  });

  await t.test('signed but unsent ticket remains uncertain and cannot be retried', async () => {
    const f = await fixture({ clientOverrides: () => ({ async sendRawTransaction() { throw new Error('LOCAL_SEND_NOT_DELIVERED'); } }) });
    await assert.rejects(f.operator.execute({ role: 'deploy', approval: f.approval }), /LOCAL_SEND_NOT_DELIVERED/);
    assert.equal((await createReleaseOperator(f.options).execute({ role: 'deploy', approval: f.approval })).status, 'pending-or-unknown');
    assert.deepEqual(f.counters, { signatures: 1, broadcasts: 0 });
  });

  await t.test('failed pin prevents broadcast and leaves reservation blocked', async () => {
    const f = await fixture({ journalOverride: backing => ({ ...backing, async pin() { throw new Error('LOCAL_DISK_FAILURE'); } }) });
    await assert.rejects(f.operator.execute({ role: 'deploy', approval: f.approval }), /LOCAL_DISK_FAILURE/);
    assert.equal((await f.operator.reconcile('deploy')).status, 'blocked-unsigned-attempt');
    assert.deepEqual(f.counters, { signatures: 1, broadcasts: 0 });
  });

  const reserveUnsigned = async f => {
    const { selectedGas } = await f.operator.preflight('deploy');
    const entry = { format: 'account-reserve-operator-attempt/v1', proposalHash: f.proposalHash, role: 'deploy', phase: 'reserved', gas: selectedGas, hash: null };
    await f.backing.withLock(() => f.backing.reserve(entry));
    return entry;
  };

  await t.test('explicit unsigned resume preserves original bytes and signs/sends once after a stopped preflight', async () => {
    let estimates = 0, interrupt = true;
    const f = await fixture({ clientOverrides: (client, index) => index === 0 ? { estimateGas: async args => {
      if (++estimates === 2 && interrupt) throw new Error('LOCAL_TRANSIENT_PREFLIGHT');
      return client.estimateGas(args);
    } } : {} });
    await assert.rejects(f.operator.execute({ role: 'deploy', approval: f.approval }), error => error.message === 'LOCAL_TRANSIENT_PREFLIGHT' && error.operatorStage === 'preflight-before-sign');
    assert.deepEqual(f.counters, { signatures: 0, broadcasts: 0 });
    const reservationPath = join(f.directory, `${f.proposalHash}-deploy-reserved.journal.json`);
    const original = await readFile(reservationPath, 'utf8');
    interrupt = false;
    assert.equal((await f.operator.preflight('deploy')).status, 'preflight-ready');
    assert.equal(await f.backing.readResume('deploy'), undefined);
    await f.operator.resumeUnsigned({ role: 'deploy', approval: f.approval });
    assert.equal((await f.finalize('deploy')).status, 'finalized');
    assert.equal(await readFile(reservationPath, 'utf8'), original);
    const audit = await f.backing.readResume('deploy');
    assert.equal(audit.format, 'account-reserve-operator-resume/v1');
    assert.equal(audit.gas, JSON.parse(original).gas);
    assert.match(audit.reservationHash, /^[0-9a-f]{64}$/);
    assert.equal((await createReleaseOperator(f.options).resumeUnsigned({ role: 'deploy', approval: f.approval })).status, 'finalized');
    assert.deepEqual(f.counters, { signatures: 1, broadcasts: 1 });
  });

  await t.test('unsigned resume refuses expired approval, changed state and increased gas before audit/signing', async () => {
    const f = await fixture(); await reserveUnsigned(f);
    await assert.rejects(f.operator.resumeUnsigned({ role: 'deploy', approval: { ...f.approval, expiresAt: new Date(Date.now() - 1).toISOString() } }), /OPERATOR_APPROVAL_EXPIRED/);
    for (const overrides of [client => ({ getTransactionCount: args => args.blockTag === 'pending' ? 1 : client.getTransactionCount(args) }), () => ({ estimateGas: async () => 500000n })]) {
      const operator = createReleaseOperator({ ...f.options, endpoints: f.options.endpoints.map(endpoint => ({ ...endpoint, client: wrap(endpoint.client, overrides(endpoint.client)) })) });
      await assert.rejects(operator.resumeUnsigned({ role: 'deploy', approval: f.approval }), /OPERATOR_NONCE_NOT_APPROVED|OPERATOR_GAS_CHANGED/);
    }
    assert.equal(await f.backing.readResume('deploy'), undefined);
    assert.deepEqual(f.counters, { signatures: 0, broadcasts: 0 });
  });

  await t.test('resume audit readback failure prevents signing and permanently consumes this resume', async () => {
    const f = await fixture(); await reserveUnsigned(f);
    let written = false;
    const journal = { ...f.backing, async reserveResume(audit) { await f.backing.reserveResume(audit); written = true; }, async readResume(role) { const audit = await f.backing.readResume(role); return written && audit ? { ...audit, gas: '1' } : audit; } };
    const operator = createReleaseOperator({ ...f.options, journal });
    await assert.rejects(operator.resumeUnsigned({ role: 'deploy', approval: f.approval }), /OPERATOR_RESUME_READBACK_FAILED/);
    assert.equal((await f.operator.resumeUnsigned({ role: 'deploy', approval: f.approval })).status, 'blocked-resume-attempt');
    assert.deepEqual(f.counters, { signatures: 0, broadcasts: 0 });
  });

  await t.test('failed resumed signature or pin cannot cause another resume or an unpinned send', async () => {
    for (const phase of ['sign', 'pin']) {
      const f = await fixture({ ...(phase === 'sign' ? { signerOverride: () => { throw new Error('LOCAL_RESUME_SIGN_STOPPED'); } } : { journalOverride: backing => ({ ...backing, pin: async () => { throw new Error('LOCAL_RESUME_PIN_STOPPED'); } }) }) });
      await reserveUnsigned(f);
      await assert.rejects(f.operator.resumeUnsigned({ role: 'deploy', approval: f.approval }), /LOCAL_RESUME_(SIGN|PIN)_STOPPED/);
      assert.equal((await createReleaseOperator(f.options).resumeUnsigned({ role: 'deploy', approval: f.approval })).status, 'blocked-resume-attempt');
      assert.deepEqual(f.counters, { signatures: 1, broadcasts: 0 });
      assert.equal((await f.backing.read('deploy')).phase, 'reserved');
    }
  });

  await t.test('unsigned resume respects exclusive locks and rejects partial signed journals', async () => {
    const f = await fixture(); await reserveUnsigned(f);
    await f.backing.withLock(async () => { await assert.rejects(createReleaseOperator(f.options).resumeUnsigned({ role: 'deploy', approval: f.approval }), /OPERATOR_JOURNAL_LOCKED/); });
    await writeFile(join(f.directory, `${f.proposalHash}-deploy-signed.journal.json`), '{partial');
    await assert.rejects(f.operator.resumeUnsigned({ role: 'deploy', approval: f.approval }), SyntaxError);
    assert.equal(await f.backing.readResume('deploy'), undefined);
    assert.deepEqual(f.counters, { signatures: 0, broadcasts: 0 });
  });

  await t.test('durable locks reject parallel operators and stale lock leaves read-only reconciliation available', async () => {
    const f = await fixture();
    const competing = await createFileOperatorJournal({ directory: f.directory, proposalHash: f.proposalHash });
    await f.backing.withLock(async () => { await assert.rejects(competing.withLock(async () => {}), /OPERATOR_JOURNAL_LOCKED/); });
    await writeFile(join(f.directory, `${f.proposalHash}.lock`), 'crashed local test');
    await assert.rejects(f.operator.execute({ role: 'deploy', approval: f.approval }), /OPERATOR_JOURNAL_LOCKED/);
    assert.equal((await f.operator.reconcile('deploy')).status, 'not-attempted');
    assert.deepEqual(f.counters, { signatures: 0, broadcasts: 0 });
  });

  for (const [name, clientOverrides, pattern] of [
    ['receipt disagreement', (client, i) => i ? { getTransactionReceipt: async args => ({ ...await client.getTransactionReceipt(args), gasUsed: 1n }) } : {}, /OPERATOR_RECEIPT_DISAGREEMENT/],
    ['wrong transaction envelope', client => ({ getTransaction: async args => ({ ...await client.getTransaction(args), input: '0x' }) }), /OPERATOR_TRANSACTION_SCOPE_MISMATCH/],
    ['wrong recovered transaction signature', client => ({ getTransaction: async args => ({ ...await client.getTransaction(args), r: `0x${'11'.repeat(32)}` }) }), /OPERATOR_SIGNED_OWNER_MISMATCH/],
    ['runtime mismatch', client => ({ getCode: async args => { const code = await client.getCode(args); return code && code !== '0x' ? '0x6000' : code; } }), /OPERATOR_RUNTIME_MISMATCH/],
  ]) await t.test(`reconciliation rejects ${name} without a new signature or send`, async () => {
    const f = await fixture(); await f.operator.execute({ role: 'deploy', approval: f.approval });
    await f.finalize('deploy');
    const bad = createReleaseOperator({ ...f.options, signer: undefined, endpoints: f.options.endpoints.map((endpoint, index) => ({ ...endpoint, client: wrap(endpoint.client, clientOverrides(endpoint.client, index)) })) });
    await assert.rejects(bad.reconcile('deploy'), pattern);
    assert.deepEqual(f.counters, { signatures: 1, broadcasts: 1 });
  });
});
