import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const directory = dirname(fileURLToPath(import.meta.url));
const forge = process.env.CONTINUITY_FORGE ?? join(homedir(), '.foundry/bin/forge');
execFileSync(forge, ['build', '--root', directory], { stdio: 'inherit' });
const compiled = JSON.parse(readFileSync(join(directory, 'out/PaymentRight.sol/PaymentRight.json'), 'utf8'));
const source = readFileSync(join(directory, 'PaymentRight.sol'));
const artifact = {
  contractName: 'PaymentRight',
  compiler: 'solc 0.8.30; optimizer=200; EVM=prague',
  scope: 'Owned local-only synthetic Anvil payment fixture; no production deployment',
  sourceSha256: createHash('sha256').update(source).digest('hex'),
  abi: compiled.abi,
  bytecode: compiled.bytecode.object,
  deployedBytecode: compiled.deployedBytecode.object,
};
writeFileSync(join(directory, 'PaymentRight.artifact.json'), JSON.stringify(artifact, null, 2) + '\n');
console.log('Local PaymentRight artifact rebuilt from owned Solidity source.');
