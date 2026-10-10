import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const directory = dirname(fileURLToPath(import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), 'sequential-payment-build-'));
try {
  const source = readFileSync(join(directory, 'SequentialPayment.sol'));
  writeFileSync(join(temporary, 'SequentialPayment.sol'), source);
  writeFileSync(join(temporary, 'foundry.toml'), '[profile.default]\nsrc="."\nout="out"\ncache_path="cache"\nsolc_version="0.8.30"\nevm_version="paris"\noptimizer=true\noptimizer_runs=200\nbytecode_hash="none"\ncbor_metadata=false\n');
  execFileSync(process.env.CONTINUITY_FORGE ?? join(homedir(), '.foundry/bin/forge'), ['build', '--offline', '--root', temporary], { stdio: 'inherit', timeout: 60000 });
  const compiled = JSON.parse(readFileSync(join(temporary, 'out/SequentialPayment.sol/SequentialPayment.json'), 'utf8'));
  if (!compiled.metadata.compiler.version.startsWith('0.8.30+') || compiled.metadata.settings.evmVersion !== 'paris'
    || compiled.metadata.settings.optimizer.enabled !== true || compiled.metadata.settings.optimizer.runs !== 200) throw new Error('COMPILER_PROFILE_MISMATCH');
  writeFileSync(join(directory, 'SequentialPayment.artifact.json'), JSON.stringify({
    contractName: 'SequentialPayment', compiler: 'solc 0.8.30; optimizer=200; EVM=paris; bytecode metadata omitted',
    scope: 'Experimental sequential funded obligations; not a production payment protocol or evidence of adoption',
    sourceSha256: createHash('sha256').update(source).digest('hex'),
    abi: compiled.abi, bytecode: compiled.bytecode.object, deployedBytecode: compiled.deployedBytecode.object,
    immutableReferences: compiled.deployedBytecode.immutableReferences,
  }, null, 2) + '\n');
  console.log('SequentialPayment compiled offline with solc 0.8.30 and EVM Paris.');
} finally { rmSync(temporary, { recursive: true, force: true }); }
