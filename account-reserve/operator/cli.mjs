import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { argumentsFrom } from './host.mjs';
import { fail, profile } from './profile.mjs';
import { exportDatabase, importDatabase, initializeDatabase, openStore } from './store.mjs';

try {
  const action = process.argv[2], args = argumentsFrom(process.argv.slice(3));
  if (!['init', 'invite', 'export', 'import', 'status'].includes(action) || Object.keys(args).some(key => !['profile', 'database', 'file'].includes(key))) throw fail('ARGUMENTS_INVALID');
  let result;
  if (action === 'invite') {
    if (!args.file || args.database || args.profile) throw fail('ARGUMENTS_INVALID');
    mkdirSync(dirname(args.file), { recursive: true, mode: 0o700 });
    writeFileSync(args.file, randomBytes(32).toString('hex') + '\n', { flag: 'wx', mode: 0o600 });
    result = { invitationFileCreated: true, invitationPrinted: false };
  } else {
    if (!args.profile || !args.database) throw fail('ARGUMENTS_INVALID');
    const trusted = profile(JSON.parse(readFileSync(args.profile, 'utf8')));
    if (action === 'init') { if (args.file) throw fail('ARGUMENTS_INVALID'); initializeDatabase(args.database, trusted); result = { initialized: true }; }
    if (action === 'export') { if (!args.file) throw fail('ARGUMENTS_INVALID'); result = exportDatabase(args.database, trusted, args.file); }
    if (action === 'import') { if (!args.file) throw fail('ARGUMENTS_INVALID'); result = importDatabase(args.file, trusted, args.database); }
    if (action === 'status') { const store = openStore(args.database, trusted); try { result = store.counts(); } finally { store.close(); } }
  }
  process.stdout.write(JSON.stringify(result) + '\n');
} catch (error) { process.stderr.write((/^[A-Z_]+$/.test(error?.code ?? '') ? error.code : 'OPERATOR_COMMAND_FAILED') + '\n'); process.exitCode = 1; }
