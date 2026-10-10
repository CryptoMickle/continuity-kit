import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createPublicClient } from 'viem';
import { APPROVED_TESTNET_RPCS } from '../release/client-profile.mjs';
import { publicTestnetTransport } from '../release/paced-rpc.mjs';
import { createPaymentGuard, validatePaymentProfile } from './guard.mjs';

const MAX_PROFILE_BYTES = 16 * 1024;
const fail = code => Object.assign(new Error(code), { code });
const DIAGNOSTICS = new Set([
  'CLAIM_ARGUMENTS_INVALID', 'CLAIM_PROFILE_UNAVAILABLE', 'CLAIM_PROFILE_INVALID', 'CLAIM_VERIFICATION_FAILED',
  'PAYMENT_TESTNET_REQUIRED', 'PAYMENT_NOT_APPROVED', 'PAYMENT_CLIENTS_INVALID',
  'PAYMENT_RECEIPT_UNAVAILABLE', 'PAYMENT_RECEIPT_MISMATCH', 'PAYMENT_RECEIPT_DISAGREEMENT',
  'PAYMENT_EVENT_MISMATCH', 'PAYMENT_CHAIN_MISMATCH', 'PAYMENT_RUNTIME_MISMATCH', 'PAYMENT_ISSUER_MISMATCH',
  'PAYMENT_CANONICAL_BLOCK_MISMATCH', 'PAYMENT_FINALIZED_HEAD_INVALID', 'PAYMENT_TRANSACTION_MISMATCH',
  'PAYMENT_TRANSACTION_SIGNATURE_INVALID', 'PAYMENT_TRANSACTION_HASH_MISMATCH', 'PAYMENT_SIGNED_OWNER_MISMATCH',
  'PAYMENT_RIGHT_MISMATCH',
]);
function safeCode(error) {
  try {
    const code = Object.getOwnPropertyDescriptor(error, 'code')?.value;
    if (DIAGNOSTICS.has(code)) return code;
  } catch {}
  return 'CLAIM_VERIFICATION_FAILED';
}

export function parseClaimVerificationArguments(argv) {
  try {
    if (!Array.isArray(argv) || argv.length !== 6 || Reflect.ownKeys(argv).length !== 7) throw 0;
    const values = Array.from({ length: 6 }, (_, index) => {
      const descriptor = Object.getOwnPropertyDescriptor(argv, String(index));
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'string') throw 0;
      return descriptor.value;
    });
    const fields = {};
    for (let i = 0; i < values.length; i += 2) {
      const flag = values[i];
      if (!['--profile', '--right-id', '--hash'].includes(flag) || Object.hasOwn(fields, flag)) throw 0;
      fields[flag] = values[i + 1];
    }
    if (!fields['--profile'] || fields['--profile'].length > 4096 || fields['--profile'].includes('\0') || fields['--profile'].startsWith('--')) throw 0;
    const id = fields['--right-id'];
    if (!/^[1-9][0-9]{0,77}$/.test(id) || String(BigInt(id)) !== id || BigInt(id) >= 2n ** 256n) throw 0;
    if (fields['--hash']?.length !== 66 || !/^0x[0-9a-f]{64}$/i.test(fields['--hash'])) throw 0;
    return Object.freeze({ profile: fields['--profile'], rightId: BigInt(id), hash: fields['--hash'].toLowerCase() });
  } catch { throw fail('CLAIM_ARGUMENTS_INVALID'); }
}

async function readPublicProfile(path) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size < 1n || before.size > BigInt(MAX_PROFILE_BYTES)) throw 0;
    const bytes = Buffer.alloc(MAX_PROFILE_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await handle.read(bytes, length, bytes.length - length, length);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (BigInt(length) !== before.size || ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].some(key => before[key] !== after[key])) throw 0;
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length));
  } catch { throw fail('CLAIM_PROFILE_UNAVAILABLE'); }
  finally { await handle?.close(); }
}

function parsePublicProfile(text) {
  try {
    if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_PROFILE_BYTES) throw 0;
    const input = JSON.parse(text);
    // A public JSON profile carries decimal strings, never private signing data.
    // validatePaymentProfile enforces the exact field set and immutable policy.
    if (!Array.isArray(input?.claims) || input.claims.length < 1 || input.claims.length > 8) throw 0;
    for (const claim of input.claims) {
      for (const field of ['rightId', 'amount']) {
        if (typeof claim?.[field] !== 'string' || !/^[1-9][0-9]{0,77}$/.test(claim[field]) || String(BigInt(claim[field])) !== claim[field]) throw 0;
        claim[field] = BigInt(claim[field]);
      }
    }
    return validatePaymentProfile(input);
  } catch { throw fail('CLAIM_PROFILE_INVALID'); }
}

function publicClients() {
  const chain = { id: 10143, name: 'Monad testnet receipt verifier', nativeCurrency: { name: 'Test MON', symbol: 'MON', decimals: 18 }, rpcUrls: { default: { http: [...APPROVED_TESTNET_RPCS] } } };
  return APPROVED_TESTNET_RPCS.map(url => createPublicClient({ chain, ccipRead: false, cacheTime: 0, transport: publicTestnetTransport(url) }));
}

// Dependencies are for offline tests; the CLI accepts no transport, signer,
// environment, journal or endpoint configuration. It never polls or discovers a hash.
export async function runClaimVerification(argv, { readProfile = readPublicProfile, createClients = publicClients } = {}) {
  try {
    const input = parseClaimVerificationArguments(argv);
    if (typeof readProfile !== 'function' || typeof createClients !== 'function') throw fail('CLAIM_ARGUMENTS_INVALID');
    let text;
    try { text = await readProfile(input.profile); } catch { throw fail('CLAIM_PROFILE_UNAVAILABLE'); }
    const profile = parsePublicProfile(text);
    if (profile.chainId !== 10143) throw fail('PAYMENT_TESTNET_REQUIRED');
    const intent = profile.claims.find(claim => claim.rightId === input.rightId);
    if (!intent) throw fail('PAYMENT_NOT_APPROVED');
    const selected = createPaymentGuard({ profile, clients: createClients() }).forRight(input.rightId);
    const identity = { chainId: profile.chainId, contract: profile.address, beneficiary: profile.owner, rightId: String(input.rightId), amount: String(intent.amount), hash: input.hash, readOnly: true };
    let receipt;
    try { receipt = await selected.getTransactionReceipt({ hash: input.hash }); }
    catch (error) {
      if (Object.getOwnPropertyDescriptor(error, 'code')?.value === 'PAYMENT_CONFIRMATION_PENDING') return Object.freeze({ ...identity, status: 'pending-or-unknown', finalized: false, paymentVerified: false });
      throw error;
    }
    return Object.freeze({ ...identity, status: receipt.status === 'success' ? 'finalized' : 'reverted', finalized: true, paymentVerified: receipt.status === 'success', blockNumber: String(receipt.blockNumber), blockHash: receipt.blockHash });
  } catch (error) { throw fail(safeCode(error)); }
}

if (process.argv[1] && await realpath(process.argv[1]).catch(() => '') === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(JSON.stringify(await runClaimVerification(process.argv.slice(2))) + '\n'); }
  catch (error) { process.stderr.write(JSON.stringify({ status: 'error', code: safeCode(error), paymentVerified: false, readOnly: true }) + '\n'); process.exitCode = 1; }
}
