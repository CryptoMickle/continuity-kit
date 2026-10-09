import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { runTextRecoveryDrill } from '../drill/text-drill.mjs';

let name = 'run-' + new Date().toISOString().replace(/[:.]/g, '-'), json = false;
for (const argument of process.argv.slice(2)) {
  if (argument === '--help') {
    console.log('Usage: node scripts/text-recovery-drill.mjs [--out=run-name] [--json]\nLocal account-free text recovery versus a real encrypted-file backup. Fresh Node recovery processes, synthetic credentials, loopback HTTP only. Outputs stay under drill/text-evidence/. No native passkey, external service or transaction.');
    process.exit(0);
  } else if (argument.startsWith('--out=')) name = argument.slice(6);
  else if (argument === '--json') json = true;
  else throw new Error('UNKNOWN_TEXT_DRILL_ARGUMENT');
}
if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/.test(name) || name.includes('..')) throw new Error('OUTPUT_NAME_INVALID');
const outputDirectory = join(fileURLToPath(new URL('../drill/text-evidence/', import.meta.url)), name);
const report = await runTextRecoveryDrill({ outputDirectory });
console.log(json ? JSON.stringify(report, null, 2) : `Text drill: ${report.status}. Six comparisons: twelve fresh recovery processes plus one independent file-readiness process. One immutable reserve write.\nReport: ${outputDirectory}/report.json\nCounts are API calls, not native prompts or human effort.`);
