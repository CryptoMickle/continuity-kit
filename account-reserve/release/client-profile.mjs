import { getAddress, parseAbi } from 'viem';
import { httpsOrigin } from './profile.mjs';

export const APPROVED_TESTNET_RPCS = Object.freeze(['https://testnet-rpc.monad.xyz', 'https://rpc-testnet.monadinfra.com']);
export const PAYMENT_RIGHT_ABI = parseAbi([
  'function claim(uint256 id)',
  'function issuer() view returns (address)',
  'function rightForOwner(address owner) view returns (uint256)',
  'function getRight(uint256 id) view returns ((address beneficiary,uint256 amount,bool claimed))',
  'event RightClaimed(uint256 indexed id, address indexed beneficiary, uint256 amount)',
]);
const fail = code => Object.assign(new Error(code), { code });
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const fields = ['format', 'enabled', 'chainId', 'contractAddress', 'expectedRuntimeCodeHash', 'issuer', 'primaryOrigin', 'recoveryOrigin', 'namespace', 'expiresAt', 'physicalPasskeysVerified', 'rpcUrls', 'claim'];
const claim = Object.freeze({ rightId: '1', gasLimit: '300000', maxFeePerGasWei: '200000000000', maxPriorityFeePerGasWei: '2000000000', valueWei: '0' });
function nonzeroAddress(value) {
  try { const address = getAddress(value); if (!/^0x0{40}$/i.test(address)) return address; } catch { /* Invalid address. */ }
  throw fail('PUBLIC_PROFILE_INVALID');
}

// enabled is a mechanical switch, never evidence of the user's approval.
// allowExpired supports read-only reconciliation; signing checks expiry again.
export function validateClientProfile(input, { now = Date.now(), allowExpired = false } = {}) {
  if (!input || input.enabled !== true) throw fail('PUBLIC_RELEASE_DISABLED');
  if (!exact(input, fields) || input.format !== 'account-reserve-public/v1' || input.chainId !== 10143 || typeof input.physicalPasskeysVerified !== 'boolean') throw fail('PUBLIC_PROFILE_INVALID');
  const contractAddress = nonzeroAddress(input.contractAddress), issuer = nonzeroAddress(input.issuer);
  if (contractAddress === issuer || typeof input.expectedRuntimeCodeHash !== 'string' || !/^0x[0-9a-f]{64}$/.test(input.expectedRuntimeCodeHash) || /^0x0{64}$/.test(input.expectedRuntimeCodeHash)) throw fail('PUBLIC_PROFILE_INVALID');
  let primaryOrigin, recoveryOrigin;
  try { primaryOrigin = httpsOrigin(input.primaryOrigin); recoveryOrigin = httpsOrigin(input.recoveryOrigin); } catch { throw fail('PUBLIC_PROFILE_INVALID'); }
  if (primaryOrigin === recoveryOrigin || typeof input.namespace !== 'string' || !/^account-reserve-[0-9a-f]{32}$/.test(input.namespace)) throw fail('PUBLIC_PROFILE_INVALID');
  if (!Array.isArray(input.rpcUrls) || input.rpcUrls.length !== 2 || input.rpcUrls.some((url, i) => url !== APPROVED_TESTNET_RPCS[i])) throw fail('PUBLIC_RPC_NOT_APPROVED');
  if (!exact(input.claim, Object.keys(claim)) || Object.keys(claim).some(key => input.claim[key] !== claim[key])) throw fail('PUBLIC_CLAIM_NOT_APPROVED');
  const expires = Date.parse(input.expiresAt);
  if (typeof input.expiresAt !== 'string' || !Number.isSafeInteger(expires) || expires <= 0 || expires > now + 45 * 86400000 || new Date(expires).toISOString() !== input.expiresAt || !Number.isSafeInteger(now)) throw fail('PUBLIC_PROFILE_INVALID');
  if (!allowExpired && expires <= now) throw fail('PUBLIC_RELEASE_EXPIRED');
  return Object.freeze({ ...input, contractAddress, issuer, primaryOrigin, recoveryOrigin, rpcUrls: APPROVED_TESTNET_RPCS, claim });
}
