import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { runRecoveryDrill, formatDrillSummary } from '../drill/run.mjs';

const options = { fixture: {} };
let name = 'run-' + new Date().toISOString().replace(/[:.]/g, '-'), json = false;
for (const argument of process.argv.slice(2)) {
  if (argument === '--help') {
    console.log('Usage: node scripts/work-recovery-drill.mjs [--out=run-name] [--seed=public-fixture-label] [--creation-fallback] [--json]\nRuns real SDK/Mera code with synthetic credentials and disposable loopback hosts. Outputs stay under drill/evidence/. Never use real credentials, funds or private data.');
    process.exit(0);
  } else if (argument.startsWith('--out=')) name = argument.slice(6);
  else if (argument.startsWith('--seed=')) options.fixture.seed = argument.slice(7);
  else if (argument === '--creation-fallback') options.fixture.creationFallback = true;
  else if (argument === '--json') json = true;
  else throw new Error('UNKNOWN_DRILL_ARGUMENT');
}
if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/.test(name) || name.includes('..')) throw new Error('OUTPUT_NAME_INVALID');
options.outputDirectory = join(fileURLToPath(new URL('../drill/evidence/', import.meta.url)), name);
const report = await runRecoveryDrill(options);
console.log(json ? JSON.stringify(report, null, 2) : formatDrillSummary(report) + '\nReport: drill/evidence/' + name + '/report.json');
process.exitCode = report.status === 'passed' ? 0 : 1;
