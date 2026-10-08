import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, chmod, symlink, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { privateKeyToAccount } from 'viem/accounts';
import { buildReleaseProposal } from '../deploy/proposal.mjs';
import { OPERATOR_ROLES, operatorProposalHash } from '../deploy/operator.mjs';
import { createFileOperatorJournal } from '../deploy/operator-journal.mjs';
import { createPacedRequest, createPinnedOperatorClients, parseOperatorArguments, readProtectedOperatorSigner, runOperatorRunner, safeOperatorDiagnostic } from '../deploy/operator-runner.mjs';
import { APPROVED_TESTNET_RPCS } from '../release/client-profile.mjs';

// Deliberately public disposable test keys; no environment or real signer file.
const key = `0x${'1'.padStart(64, '0')}`;
const issuer = privateKeyToAccount(key), beneficiary = privateKeyToAccount(`0x${'2'.padStart(64, '0')}`);
const proposal = buildReleaseProposal({ issuer: issuer.address, beneficiary: beneficiary.address, issuerNonce: '0', beneficiaryNonce: '0' });
const proposalHash = operatorProposalHash(proposal);
const base = ['--proposal', 'proposal.json', '--journal-dir', 'tickets'];
const executeArgs = ['execute', ...base, '--role', 'deploy', '--approve-exact-proposal', '--approval', 'approval.json', '--signer', 'signer.json'];
const approval = () => ({ format: 'account-reserve-operator-approval/v1', proposalHash, network: 'public-testnet', rpcUrls: [...APPROVED_TESTNET_RPCS], roles: [...OPERATOR_ROLES], approvedByUser: true, expiresAt: new Date(Date.now() + 3600000).toISOString() });
const memoryJournal = () => ({ durable: true, read: async () => undefined, reserve: async () => {}, pin: async () => {}, withLock: fn => fn() });
const createClients = () => APPROVED_TESTNET_RPCS.map(url => ({ url, client: {} }));

test('operator CLI defaults to inspect and rejects ambiguous/missing execution flags', () => {
  assert.equal(parseOperatorArguments(base).command, 'inspect');
  for (const args of [[], ['broadcast', ...base], ['inspect', ...base, '--signer', 'secret'], ['reconcile', ...base], ['execute', ...base, '--role', 'deploy'], [...executeArgs, '--rpc', 'https://elsewhere.invalid'], [...executeArgs, '--role', 'deploy']]) assert.throws(() => parseOperatorArguments(args), /OPERATOR_/);
});

test('pinned public adapters disable retries, redirects, CCIP read and client cache', () => {
  const transports = [], clients = [];
  const endpoints = createPinnedOperatorClients({ transport(url, config) { transports.push({ url, config }); return 'transport'; }, createClient(config) { clients.push(config); return {}; } });
  assert.deepEqual(endpoints.map(endpoint => endpoint.url), [...APPROVED_TESTNET_RPCS]);
  assert.deepEqual(transports, APPROVED_TESTNET_RPCS.map(url => ({ url, config: { retryCount: 0, timeout: 10000, fetchOptions: { redirect: 'error' } } })));
  for (const config of clients) { assert.equal(config.chain.id, 10143); assert.equal(config.ccipRead, false); assert.equal(config.cacheTime, 0); }
});

test('per-endpoint pacing spaces reads and the single write without replaying a failed read', async () => {
  let clock = 0;
  const calls = [];
  const request = createPacedRequest(async (args, options) => {
    calls.push({ args, options, at: clock });
    if (args.method === 'eth_chainId') throw Object.assign(new Error('rate limit'), { status: 429 });
    return args.method;
  }, { now: () => clock, wait: async ms => { clock += ms; } });
  const results = await Promise.allSettled([
    request({ method: 'eth_chainId' }, { retryCount: 0 }),
    request({ method: 'eth_sendRawTransaction', params: ['synthetic-test-bytes'] }, { retryCount: 0 }),
    request({ method: 'eth_blockNumber' }, { retryCount: 0 }),
  ]);
  assert.deepEqual(results.map(result => result.status), ['rejected', 'fulfilled', 'fulfilled']);
  assert.deepEqual(calls.map(call => call.at), [0, 250, 500]);
  assert.deepEqual(calls.map(call => call.args.method), ['eth_chainId', 'eth_sendRawTransaction', 'eth_blockNumber']);
  assert.equal(calls.filter(call => call.args.method === 'eth_sendRawTransaction').length, 1);
  assert.ok(calls.every(call => call.options.retryCount === 0));
});

test('missing, expired or wrong approval cannot read a signer or construct network clients', async () => {
  let signerReads = 0, clientConstructions = 0;
  for (const input of [undefined, { ...approval(), proposalHash: 'a'.repeat(64) }, { ...approval(), network: 'local-anvil' }, { ...approval(), approvedByUser: false }, { ...approval(), expiresAt: new Date(Date.now() - 1000).toISOString() }]) {
    await assert.rejects(runOperatorRunner(executeArgs, { readJson: async path => path === 'proposal.json' ? proposal : input, readSigner: async () => { signerReads++; }, createClients: () => { clientConstructions++; return createClients(); } }), /OPERATOR_/);
  }
  await assert.rejects(runOperatorRunner(['execute', ...base, '--role', 'deploy'], { readSigner: async () => { signerReads++; } }), /OPERATOR_EXPLICIT_EXECUTE_FLAGS_REQUIRED/);
  assert.equal(signerReads, 0); assert.equal(clientConstructions, 0);
});

test('inspection and empty reconciliation never open signer; valid execute reaches only explicit signer path', async () => {
  let signerReads = 0;
  const dependencies = { readJson: async path => path === 'proposal.json' ? proposal : approval(), createClients, createJournal: async () => memoryJournal(), readSigner: async path => { signerReads++; assert.equal(path, 'signer.json'); throw new Error('LOCAL_TEST_SIGNER_BOUNDARY'); } };
  assert.equal((await runOperatorRunner(base, dependencies)).attempts.length, 3);
  assert.equal((await runOperatorRunner(['reconcile', ...base, '--role', 'deploy'], dependencies)).status, 'not-attempted');
  assert.equal(signerReads, 0);
  await assert.rejects(runOperatorRunner(executeArgs, dependencies), /LOCAL_TEST_SIGNER_BOUNDARY/);
  assert.equal(signerReads, 1);
});

test('existing reserved attempt never reloads signer during an explicit execute invocation', async () => {
  const entry = { format: 'account-reserve-operator-attempt/v1', proposalHash, role: 'deploy', phase: 'reserved', gas: '1000000', hash: null };
  const result = await runOperatorRunner(executeArgs, { readJson: async path => path === 'proposal.json' ? proposal : approval(), createClients, createJournal: async () => ({ ...memoryJournal(), read: async role => role === 'deploy' ? entry : undefined }), readSigner: async () => { assert.fail('signer must not be read'); } });
  assert.equal(result.status, 'blocked-unsigned-attempt');
});

test('explicit resume and readonly preflight have separate argument boundaries', () => {
  assert.equal(parseOperatorArguments(['resume-unsigned', ...executeArgs.slice(1)]).command, 'resume-unsigned');
  assert.equal(parseOperatorArguments(['preflight', ...base, '--role', 'deploy']).command, 'preflight');
  assert.throws(() => parseOperatorArguments(['resume-unsigned', ...base, '--role', 'deploy']), /OPERATOR_EXPLICIT_EXECUTE_FLAGS_REQUIRED/);
  assert.throws(() => parseOperatorArguments(['preflight', ...base, '--role', 'deploy', '--signer', 'secret']), /OPERATOR_READONLY_SIGNER_FORBIDDEN/);
});

test('signed or already consumed resume does not read a signer; preflight is readonly', async () => {
  const entry = { format: 'account-reserve-operator-attempt/v1', proposalHash, role: 'deploy', phase: 'reserved', gas: '1000000', hash: null };
  let signerReads = 0;
  const dependencies = { readJson: async path => path === 'proposal.json' ? proposal : approval(), createClients, readSigner: async () => { signerReads++; throw new Error('SIGNER_MUST_NOT_BE_OPENED'); } };
  const resume = ['resume-unsigned', ...executeArgs.slice(1)];
  const consumed = await runOperatorRunner(resume, { ...dependencies, createJournal: async () => ({ ...memoryJournal(), read: async role => role === 'deploy' ? entry : undefined, readResume: async () => ({ consumed: true }) }) });
  assert.equal(consumed.status, 'blocked-resume-attempt');
  // Empty mock clients deliberately stop read-only reconciliation, after the
  // signed-ticket branch, without supplying any real network transport.
  await assert.rejects(runOperatorRunner(resume, { ...dependencies, createJournal: async () => ({ ...memoryJournal(), read: async role => role === 'deploy' ? { ...entry, phase: 'signed', hash: `0x${'12'.repeat(32)}` } : undefined }) }), error => error.operatorStage === 'reconcile');
  await assert.rejects(runOperatorRunner(['preflight', ...base, '--role', 'deploy'], { ...dependencies, createJournal: async () => memoryJournal() }), error => error.operatorStage === 'readonly-preflight');
  assert.equal(signerReads, 0);
});

test('safe CLI diagnostics expose only stage, bounded names/codes and HTTP status', () => {
  const error = Object.assign(new Error('PRIVATE_KEY secret rawTransaction requestBody /private/path'), { name: 'HttpRequestError', operatorStage: 'preflight-before-sign', status: 429, requestBody: 'secret', cause: Object.assign(new Error('nested secret'), { code: -32005, status: 503 }) });
  assert.deepEqual(safeOperatorDiagnostic(error), { error: 'OPERATOR_RUNNER_FAILED', stage: 'preflight-before-sign', causes: [{ name: 'HttpRequestError', status: 429 }, { name: 'Error', code: -32005, status: 503 }] });
  assert.doesNotMatch(JSON.stringify(safeOperatorDiagnostic(error)), /secret|private|rawTransaction|requestBody/);
  error.cause.cause = error;
  assert.equal(safeOperatorDiagnostic(error).causes.length, 2);
});

test('protected signer reader rejects permissive files, symlinks and malformed data', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'operator-reader-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'synthetic-key.json');
  await writeFile(path, JSON.stringify({ privateKey: key }), { mode: 0o600 });
  assert.equal((await readProtectedOperatorSigner(path)).address, issuer.address);
  await chmod(path, 0o644); await assert.rejects(readProtectedOperatorSigner(path), /OPERATOR_SIGNER_FILE_NOT_PROTECTED/);
  await chmod(path, 0o600);
  const link = join(directory, 'linked-key.json'); await symlink(path, link); await assert.rejects(readProtectedOperatorSigner(link), /OPERATOR_SIGNER_FILE_INVALID/);
  await writeFile(path, JSON.stringify({ privateKey: key, extra: true })); await assert.rejects(readProtectedOperatorSigner(path), /OPERATOR_SIGNER_FILE_INVALID/);
  await writeFile(path, JSON.stringify({ privateKey: `0x${'0'.repeat(64)}` })); await assert.rejects(readProtectedOperatorSigner(path), /OPERATOR_SIGNER_FILE_INVALID/);
});

test('read-only journal does not create directories and rejects lock acquisition', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'operator-readonly-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const missing = join(directory, 'absent');
  const journal = await createFileOperatorJournal({ directory: missing, proposalHash, readOnly: true });
  assert.equal(await journal.read('deploy'), undefined);
  await assert.rejects(journal.withLock(async () => {}), /OPERATOR_JOURNAL_READ_ONLY/);
  await assert.rejects(stat(missing), { code: 'ENOENT' });
});
