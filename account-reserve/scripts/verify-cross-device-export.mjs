import { constants, openSync, closeSync, fstatSync, readSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { extname } from 'node:path';
import { pathToFileURL } from 'node:url';

// Local file comparison only. No SDK, network, browser, credential or storage API.
// These are the existing text-v1 editor exports, not encrypted reserve records.
const MAX_TEXT_BYTES = 16384;
const MAX_JSON_BYTES = MAX_TEXT_BYTES * 6 + 128;
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const fail = code => { throw Object.assign(new Error(code), { code }); };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const unchanged = (a, b) => ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(key => a[key] === b[key]);

function readExport(path) {
  if (typeof path !== 'string' || !path || path.includes('\0')) fail('EXPORT_PATH_INVALID');
  const extension = extname(path).toLowerCase();
  if (!['.txt', '.json'].includes(extension)) fail('EXPORT_FORMAT_UNSUPPORTED');
  const limit = extension === '.txt' ? MAX_TEXT_BYTES : MAX_JSON_BYTES;
  let fd, raw, textBytes;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.size > BigInt(limit)) fail('EXPORT_FILE_INVALID');
    raw = Buffer.alloc(limit + 1);
    let size = 0;
    while (size < raw.length) {
      const count = readSync(fd, raw, size, raw.length - size, null);
      if (!count) break;
      size += count;
    }
    const after = fstatSync(fd, { bigint: true });
    if (size > limit || BigInt(size) !== before.size || !unchanged(before, after)) fail('EXPORT_FILE_CHANGED_OR_TOO_LARGE');
    const fileBytes = raw.subarray(0, size);
    let text;
    try { text = decoder.decode(fileBytes); } catch { fail('EXPORT_UTF8_INVALID'); }
    if (extension === '.json') {
      let value;
      try { value = JSON.parse(text); } catch { fail('EXPORT_JSON_INVALID'); }
      if (!value || Array.isArray(value) || Object.keys(value).length !== 2 || value.format !== 'continuity-text-export/v1' || typeof value.text !== 'string') fail('EXPORT_JSON_INVALID');
      // Matches both hosted TXT editors and the collection view. This also
      // rejects duplicate keys, foreign fields and ambiguous modified envelopes.
      if (JSON.stringify({ format: 'continuity-text-export/v1', text: value.text }, null, 2) + '\n' !== text) fail('EXPORT_JSON_NONCANONICAL');
      text = value.text;
    }
    textBytes = Buffer.from(text, 'utf8');
    if (textBytes.length > MAX_TEXT_BYTES) fail('EXPORT_TEXT_TOO_LARGE');
    if (decoder.decode(textBytes) !== text) fail('EXPORT_UTF8_INVALID');
    return {
      identity: { dev: before.dev, ino: before.ino }, textBytes,
      summary: { format: extension === '.txt' ? 'txt' : 'continuity-text-export/v1', fileBytes: size, fileSha256: digest(fileBytes), textBytes: textBytes.length, textSha256: digest(textBytes) },
    };
  } catch (error) {
    textBytes?.fill(0);
    if (typeof error?.code === 'string' && error.code.startsWith('EXPORT_')) throw error;
    fail('EXPORT_FILE_UNREADABLE');
  } finally {
    raw?.fill(0);
    if (fd !== undefined) closeSync(fd);
  }
}

/** A match establishes the supplied files' content only, not their provenance. */
export function verifyCrossDeviceExport({ original, recovered, marker } = {}) {
  let first, second, markerBytes;
  try {
    if (marker !== undefined) {
      if (typeof marker !== 'string' || !marker) fail('EXPORT_MARKER_INVALID');
      markerBytes = Buffer.from(marker, 'utf8');
      if (markerBytes.length > 256 || decoder.decode(markerBytes) !== marker) fail('EXPORT_MARKER_INVALID');
    }
    first = readExport(original);
    second = readExport(recovered);
    if (first.identity.dev === second.identity.dev && first.identity.ino === second.identity.ino) fail('EXPORT_SAME_FILE');
    const exactUtf8Match = first.textBytes.equals(second.textBytes);
    const markerCheck = markerBytes ? { requested: true, originalContainsMarker: first.textBytes.includes(markerBytes), recoveredContainsMarker: second.textBytes.includes(markerBytes) } : { requested: false };
    return {
      format: 'continuitykit/export-file-comparison/v1', checkedAt: new Date().toISOString(),
      passed: exactUtf8Match && (!markerBytes || (markerCheck.originalContainsMarker && markerCheck.recoveredContainsMarker)),
      exactUtf8Match, normalizationApplied: false,
      original: first.summary, recovered: second.summary, markerCheck,
      scope: {
        localFileComparisonOnly: true, networkRequests: 0, credentialsRequested: 0, inputFilesModified: false,
        physicalDevicesIndependentlyVerified: false, existingPasskeyIdentityVerified: false,
        originalPreparationBytesVerified: false, reserveCiphertextCorrelated: false,
      },
      limits: [
        'Input labels do not establish which device or browser produced either file, or whether either file came from a reserve.',
        'A marker match is a plaintext observation, not proof of a particular credential or same-record identity.',
        'Only a separately preserved original export can support original-preparation comparison; two recovered exports establish agreement between those supplied files.',
        'The report prints hashes and sizes, not plaintext, marker text or local paths. Hashes may still identify known or guessable text; publication remains a separate decision.',
      ],
    };
  } finally {
    first?.textBytes.fill(0); second?.textBytes.fill(0); markerBytes?.fill(0);
  }
}

function argumentsFrom(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i]?.slice(2);
    if (!['--original', '--recovered', '--marker'].includes(argv[i]) || Object.hasOwn(options, name) || typeof argv[i + 1] !== 'string' || !argv[i + 1]) fail('EXPORT_ARGUMENTS_INVALID');
    options[name] = argv[i + 1];
  }
  if (!options.original || !options.recovered) fail('EXPORT_ARGUMENTS_INVALID');
  return options;
}

let main = false;
try { main = Boolean(process.argv[1]) && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url; } catch { /* Imported module. */ }
if (main) {
  try {
    if (process.argv.length === 3 && process.argv[2] === '--help') {
      console.log('Usage: node scripts/verify-cross-device-export.mjs --original FILE.txt|FILE.json --recovered FILE.txt|FILE.json [--marker TEXT]\nRead-only local comparison of existing continuity-text-export/v1 JSON or UTF-8 TXT exports (16 KiB maximum text). Does not prove device or passkey identity. No files are written. Exit 0: exact match and requested marker present; 2: mismatch; 1: invalid input.');
    } else {
      const report = verifyCrossDeviceExport(argumentsFrom(process.argv.slice(2)));
      console.log(JSON.stringify(report, null, 2));
      process.exitCode = report.passed ? 0 : 2;
    }
  } catch (error) {
    const code = typeof error?.code === 'string' && /^EXPORT_[A-Z_]+$/.test(error.code) ? error.code : 'EXPORT_CHECK_FAILED';
    console.error(JSON.stringify({ error: code }));
    process.exitCode = 1;
  }
}
