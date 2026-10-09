import { createSecretVaultWithExistingPasskey, decryptSecretVaultWithPasskey } from '@category-labs/mera';
import { validateWork } from '../sdk/work-reserve.mjs';

const FORMAT = 'synthetic-work-encrypted-export/v1';
const error = code => Object.assign(new Error(code), { code });
const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true });
const sameConfig = (a, b) => a && b && Object.keys(a).sort().join() === Object.keys(b).sort().join() && Object.keys(a).every(key => a[key] === b[key]);

/** Functional comparison for private work only. Uses the SAME existing recovery
 * credential and Mera authenticated encryption, with no host-storage dependency.
 * It does not export an account leaf or recreate optional account authority. */
export async function createEncryptedExport({ work, owner, config, credential, webAuthnClient }) {
  const secret = encoder.encode(JSON.stringify({ format: FORMAT, config, owner, work: validateWork(work) }));
  try {
    const vault = await createSecretVaultWithExistingPasskey({ secret, credential, rpId: config.recoveryRpId, webAuthnClient });
    return encoder.encode(JSON.stringify({ format: FORMAT, vault }));
  } finally { secret.fill(0); }
}

export async function importEncryptedExport({ bytes, config, webAuthnClient }) {
  if (bytes === undefined || bytes === null) throw error('BASELINE_FILE_MISSING');
  if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > 65536) throw error('BASELINE_FILE_INVALID');
  let envelope;
  try { envelope = JSON.parse(decoder.decode(bytes)); } catch { throw error('BASELINE_FILE_INVALID'); }
  if (envelope?.format !== FORMAT || Object.keys(envelope).sort().join() !== 'format,vault') throw error('BASELINE_FILE_INVALID');
  let secret;
  try { secret = await decryptSecretVaultWithPasskey({ vault: envelope.vault, rpId: config.recoveryRpId, webAuthnClient }); }
  catch { throw error('BASELINE_AUTH_FAILED'); }
  try {
    const payload = JSON.parse(decoder.decode(secret));
    if (payload?.format !== FORMAT || Object.keys(payload).sort().join() !== 'config,format,owner,work' || !sameConfig(payload.config, config)) throw error('BASELINE_POLICY_MISMATCH');
    if (!/^0x[0-9a-f]{40}$/.test(payload.owner)) throw error('BASELINE_OWNER_INVALID');
    return Object.freeze({ work: validateWork(payload.work), owner: payload.owner });
  } finally { secret.fill(0); }
}

export function tamperEncryptedExport(bytes) {
  const envelope = JSON.parse(decoder.decode(bytes));
  const data = Buffer.from(envelope.vault.ciphertext, 'base64url');
  data[Math.floor(data.length / 2)] ^= 1;
  envelope.vault.ciphertext = data.toString('base64url');
  return encoder.encode(JSON.stringify(envelope));
}
