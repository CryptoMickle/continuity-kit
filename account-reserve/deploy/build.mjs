import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { keccak256 } from 'viem';

const directory = dirname(fileURLToPath(import.meta.url));
const forge = process.env.CONTINUITY_FORGE ?? join(homedir(), '.foundry/bin/forge');
execFileSync(forge, ['build', '--offline', '--root', directory], { stdio: 'inherit' });
const compiled = JSON.parse(readFileSync(join(directory, 'out/PaymentRight.sol/PaymentRight.json'), 'utf8'));
const source = readFileSync(join(directory, 'PaymentRight.sol'));
const settings = readFileSync(join(directory, 'foundry.toml'));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
if (compiled.metadata.settings.evmVersion !== 'paris' || !compiled.metadata.compiler.version.startsWith('0.8.30+')) throw new Error('COMPILER_PROFILE_MISMATCH');
const artifact = {
  format: 'account-reserve-testnet-artifact/v1',
  contractName: 'PaymentRight',
  scope: 'Unpublished test-only candidate; local Anvil validation is not Monad deployment evidence',
  compiler: compiled.metadata.compiler.version,
  compilerSettings: { evmVersion: 'paris', optimizer: { enabled: true, runs: 200 }, bytecodeHash: 'none', appendCBOR: false },
  sourceSha256: sha256(source), settingsSha256: sha256(settings),
  creationCodeHash: keccak256(compiled.bytecode.object),
  abi: compiled.abi, bytecode: compiled.bytecode.object,
  runtimeTemplate: compiled.deployedBytecode.object,
  immutableReferences: compiled.deployedBytecode.immutableReferences,
};
writeFileSync(join(directory, 'PaymentRight.paris.json'), JSON.stringify(artifact, null, 2) + '\n');
console.log('Paris candidate built locally; no network, signing or deployment.');
