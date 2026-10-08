import { constants } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { APPROVED_TESTNET_RPCS } from '../release/client-profile.mjs';
import { createReleaseOperator, operatorProposalHash, OPERATOR_ROLES, validateOperatorApproval } from './operator.mjs';
import { createFileOperatorJournal } from './operator-journal.mjs';

const fail = code => Object.assign(new Error(code), { code });
const chain = { id: 10143, name: 'Monad testnet bounded operator', nativeCurrency: { name: 'Test MON', symbol: 'MON', decimals: 18 }, rpcUrls: { default: { http: [...APPROVED_TESTNET_RPCS] } } };

export function parseOperatorArguments(argv) {
  const args = [...argv];
  const command = args[0] && !args[0].startsWith('--') ? args.shift() : 'inspect';
  if (!['inspect', 'reconcile', 'preflight', 'execute', 'resume-unsigned'].includes(command)) throw fail('OPERATOR_COMMAND_INVALID');
  const result = { command };
  while (args.length) {
    const flag = args.shift();
    if (flag === '--approve-exact-proposal') {
      if (result.confirmed) throw fail('OPERATOR_ARGUMENTS_INVALID');
      result.confirmed = true; continue;
    }
    const key = { '--proposal': 'proposalPath', '--journal-dir': 'journalDirectory', '--role': 'role', '--approval': 'approvalPath', '--signer': 'signerPath' }[flag];
    if (!key || result[key] !== undefined || !args[0] || args[0].startsWith('--')) throw fail('OPERATOR_ARGUMENTS_INVALID');
    result[key] = args.shift();
  }
  if (!result.proposalPath || !result.journalDirectory || (result.role !== undefined && !OPERATOR_ROLES.includes(result.role))) throw fail('OPERATOR_ARGUMENTS_INVALID');
  if (command === 'inspect' && result.role !== undefined) throw fail('OPERATOR_ARGUMENTS_INVALID');
  if (command !== 'inspect' && result.role === undefined) throw fail('OPERATOR_ARGUMENTS_INVALID');
  const mutating = ['execute', 'resume-unsigned'].includes(command);
  if (mutating && (!result.confirmed || !result.approvalPath || !result.signerPath)) throw fail('OPERATOR_EXPLICIT_EXECUTE_FLAGS_REQUIRED');
  if (!mutating && (result.confirmed || result.approvalPath || result.signerPath)) throw fail('OPERATOR_READONLY_SIGNER_FORBIDDEN');
  return result;
}

// The CLI never accepts a URL, fallback endpoint, chain override or retry flag.
export function createPacedRequest(request, { intervalMs = 250, now = Date.now, wait = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  let queue = Promise.resolve(), nextStart = 0;
  return (args, options) => {
    const attempt = queue.then(async () => {
      const remaining = Math.max(0, nextStart - now());
      if (remaining) await wait(remaining);
      nextStart = now() + intervalMs;
      return request(args, options);
    });
    // Continue the queue after a failure, without replaying that request.
    queue = attempt.then(() => undefined, () => undefined);
    return attempt;
  };
}

export function createPinnedOperatorClients({ createClient = createPublicClient, transport = http } = {}) {
  return APPROVED_TESTNET_RPCS.map(url => {
    const direct = transport(url, { retryCount: 0, timeout: 10000, fetchOptions: { redirect: 'error' } });
    const paced = config => {
      const adapter = direct(config);
      return { ...adapter, request: createPacedRequest(adapter.request) };
    };
    return { url, client: createClient({ chain, ccipRead: false, cacheTime: 0, transport: paced }) };
  });
}

async function readPublicJson(path) {
  const bytes = await readFile(resolve(path));
  if (bytes.length > 100000) throw fail('OPERATOR_INPUT_TOO_LARGE');
  try { return JSON.parse(bytes.toString('utf8')); } catch { throw fail('OPERATOR_JSON_INVALID'); }
}

/** Only called after exact approval validation; never scans environment/default paths. */
export async function readProtectedOperatorSigner(path) {
  let handle, bytes;
  try {
    handle = await open(resolve(path), constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || (typeof process.getuid === 'function' && stat.uid !== process.getuid()) || stat.size > 256 || stat.size < 1) throw fail('OPERATOR_SIGNER_FILE_NOT_PROTECTED');
    bytes = await handle.readFile();
    const parsed = JSON.parse(bytes.toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).join(',') !== 'privateKey' || typeof parsed.privateKey !== 'string' || !/^0x[0-9a-f]{64}$/i.test(parsed.privateKey)) throw fail('OPERATOR_SIGNER_FILE_INVALID');
    return privateKeyToAccount(parsed.privateKey);
  } catch (error) {
    if (error?.code === 'OPERATOR_SIGNER_FILE_NOT_PROTECTED') throw error;
    throw fail('OPERATOR_SIGNER_FILE_INVALID');
  } finally { bytes?.fill(0); await handle?.close(); }
}

export async function runOperatorRunner(argv, { readJson = readPublicJson, readSigner = readProtectedOperatorSigner, createClients = createPinnedOperatorClients, createJournal = createFileOperatorJournal } = {}) {
  let stage = 'parse-arguments';
  try {
    const args = parseOperatorArguments(argv);
    stage = 'read-proposal';
    const proposal = await readJson(args.proposalPath), proposalHash = operatorProposalHash(proposal);
    let approval;
    const mutating = ['execute', 'resume-unsigned'].includes(args.command);
    if (mutating) {
      stage = 'read-approval';
      approval = await readJson(args.approvalPath);
      validateOperatorApproval({ approval, proposalHash, network: 'public-testnet', rpcUrls: APPROVED_TESTNET_RPCS });
    }
    stage = 'open-journal';
    const journal = await createJournal({ directory: args.journalDirectory, proposalHash, readOnly: !mutating });
    const options = { proposal, endpoints: createClients(), journal, network: 'public-testnet' };
    const readonly = createReleaseOperator(options);
    if (args.command === 'inspect') return { proposalHash, network: 'public-testnet', attempts: await readonly.inspect() };
    if (args.command === 'reconcile') return await readonly.reconcile(args.role);
    if (args.command === 'preflight') return await readonly.preflight(args.role);
    const prior = (await readonly.inspect()).find(item => item.role === args.role)?.attempt;
    // Normal execute remains strict. Signed resume is read-only as well.
    if (prior && (args.command === 'execute' || prior.phase === 'signed')) return await readonly.reconcile(args.role);
    if (args.command === 'resume-unsigned') {
      if (!prior || prior.phase !== 'reserved') throw fail('OPERATOR_UNSIGNED_RESERVATION_REQUIRED');
      if (typeof journal.readResume !== 'function') throw fail('OPERATOR_RESUME_JOURNAL_REQUIRED');
      if (await journal.readResume(args.role)) return { role: args.role, status: 'blocked-resume-attempt', action: 'manual-reconciliation-required' };
      // Diagnose state before opening a signer or consuming the one resume.
      const fresh = await readonly.preflight(args.role);
      if (BigInt(fresh.selectedGas) > BigInt(prior.gas)) throw fail('OPERATOR_GAS_CHANGED');
    }
    validateOperatorApproval({ approval, proposalHash, network: 'public-testnet', rpcUrls: APPROVED_TESTNET_RPCS });
    stage = 'read-protected-signer';
    const signer = await readSigner(args.signerPath);
    const operator = createReleaseOperator({ ...options, signer });
    return await (args.command === 'resume-unsigned' ? operator.resumeUnsigned({ role: args.role, approval }) : operator.execute({ role: args.role, approval }));
  } catch (error) {
    if (error && typeof error === 'object' && error.operatorStage === undefined) error.operatorStage = stage;
    throw error;
  }
}

// Intentionally exclude messages, stacks, URLs, request bodies and arbitrary
// enumerable properties. RPC errors can otherwise embed signed transactions.
export function safeOperatorDiagnostic(error) {
  const result = { error: /^[A-Z][A-Z0-9_]{0,79}$/.test(error?.code ?? '') ? error.code : 'OPERATOR_RUNNER_FAILED' };
  if (/^[a-z][a-z0-9-]{0,79}$/.test(error?.operatorStage ?? '')) result.stage = error.operatorStage;
  result.causes = [];
  const seen = new Set();
  for (let item = error; item && typeof item === 'object' && !seen.has(item) && result.causes.length < 6; item = item.cause) {
    seen.add(item); const diagnostic = {};
    if (/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(item.name ?? '')) diagnostic.name = item.name;
    if (Number.isSafeInteger(item.code) || /^[A-Z][A-Z0-9_]{0,79}$/.test(item.code ?? '')) diagnostic.code = item.code;
    if (Number.isSafeInteger(item.status) && item.status >= 100 && item.status <= 599) diagnostic.status = item.status;
    if (Object.keys(diagnostic).length) result.causes.push(diagnostic);
  }
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await runOperatorRunner(process.argv.slice(2)), null, 2)); }
  catch (error) {
    // Never echo input files, serialized transactions, signer data or RPC bodies.
    console.error(JSON.stringify(safeOperatorDiagnostic(error)));
    process.exitCode = 1;
  }
}
