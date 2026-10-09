import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTextReserveCredential, prepareTextReserve, recoverTextReserve } from '@continuitykit/account-reserve/text-reserve';
import { createReserveHttpStore } from '@continuitykit/account-reserve/http-store';
import { startIntegration } from './server.mjs';
import { loopbackFetch } from './loopback-fetch.mjs';
import { syntheticClient } from './synthetic-client.mjs';
import { captureText, restoreText, exportText } from './adapter.mjs';
import { createEditorTestHost } from './editor-test-host.mjs';

async function freshRecovery(origin) {
  const fetcher = loopbackFetch(origin);
  const env = await (await fetcher('/api/config')).json();
  assert.equal(env.enrollmentToken, undefined, 'recovery receives no enrollment capability');
  const host = await createEditorTestHost(origin);
  const directory = await mkdtemp(join(tmpdir(), 'textarea-text-exports-'));
  try {
    const recovered = await recoverTextReserve({ config: env.config, store: createReserveHttpStore({ fetcher }), webAuthnClient: syntheticClient(fetcher) });
    assert.deepEqual(Object.keys(recovered).sort(), ['locator', 'protocol', 'text', 'textDigest']);
    restoreText(recovered.text, host.editor);
    assert.equal(host.readDocument(), recovered.text);
    assert.ok(host.article.querySelector('.md-h1'), 'actual upstream highlighter ran');
    const original = captureText(host.readDocument());
    assert.equal(await host.paste('\n\nRecovered editor: final sentence completed.'), true);
    const edited = host.readDocument();
    assert.equal(edited.endsWith('final sentence completed.'), true);
    const upstreamTxt = await host.exportUpstreamTxt();
    assert.equal(upstreamTxt, edited, 'upstream Save as txt exports the recovered and edited document');
    const txt = exportText(edited, 'txt'), json = exportText(edited, 'json');
    assert.equal(txt, upstreamTxt);
    assert.deepEqual(JSON.parse(json), { text: edited });
    // Actual filesystem bytes are read back. The editor menu uses an emulated
    // picker; this test does not claim a physical browser download.
    await writeFile(join(directory, 'document.txt'), txt, 'utf8');
    await writeFile(join(directory, 'document.json'), json, 'utf8');
    assert.equal(await readFile(join(directory, 'document.txt'), 'utf8'), edited);
    assert.deepEqual(JSON.parse(await readFile(join(directory, 'document.json'), 'utf8')), { text: edited });
    assert.equal(host.historyWrites, 0); assert.equal(host.serviceWorkerRequests, 0);
    console.log(JSON.stringify({ recovered: original, editedExport: edited,
      upstreamEditorRendered: true, upstreamTxtExportExecuted: true, exportsReadBack: true,
      noAccountModel: true, plaintextUrlWrites: host.historyWrites, serviceWorkerRequests: host.serviceWorkerRequests }));
  } finally { host.close(); await rm(directory, { recursive: true, force: true }); }
}
function childRecovery(origin) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--fresh-recovery', origin], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('FRESH_PROCESS_TIMEOUT')); }, 15000);
    child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('exit', code => { clearTimeout(timer); if (code !== 0) reject(new Error(stderr || stdout || 'RECOVERY_PROCESS_FAILED')); else { try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); } } });
  });
}

async function run() {
  const app = await startIntegration({ primaryPort: 5673, recoveryPort: 5674 });
  const original = await createEditorTestHost(app.originalOrigin);
  const a = loopbackFetch(app.originalOrigin), b = loopbackFetch(app.recoveryOrigin);
  let credential;
  try {
    original.editor.set('# Old note\n\nOld body.\n');
    original.selectPrefix(original.readDocument().length - 1);
    const replacement = '# Replacement\n\nClipboard body.\n';
    await original.paste(replacement, { keepSelection: true });
    assert.equal(original.readDocument(), replacement + '\n', 'a genuinely partial selection retains the unselected terminal LF');
    assert.equal(original.selectAll(), original.readDocument(), 'explicit select-all includes every terminal LF');
    await original.paste(replacement, { keepSelection: true });
    assert.equal(original.readDocument(), replacement, 'select-all paste keeps exactly the clipboard terminal LF');
    original.selectAll();
    await original.paste(replacement + '\n', { keepSelection: true });
    assert.equal(original.readDocument(), replacement + '\n', 'two intentional clipboard terminal LFs are not trimmed');
    original.editor.set('# Original document\n\nUnfinished content.');
    const beforePaste = original.readDocument();
    const pasted = '# Plain paste proof\n\nTwo separate paragraphs.\n\nUnicode ÆØÅ 📝.\n';
    assert.equal(await original.paste(pasted, { replace: true }), true);
    assert.equal(original.readDocument(), pasted, 'plain paste keeps every line break including trailing newline');
    assert.ok(original.article.querySelector('.md-h1'));
    original.undo();
    assert.equal(original.readDocument(), beforePaste, 'upstream undo returns to the complete pre-paste document');
    for (const [html, text] of [
      ['<div><span># Browser shape</span></div><div><br></div><div>Paragraph one.</div><div><br></div><div>Paragraph two.</div>', '# Browser shape\n\nParagraph one.\n\nParagraph two.'],
      ['<span class="md-h1"># Heading</span><br><br><span>Body.</span>', '# Heading\n\nBody.'],
      ['<span>One<br></span>Two', 'One\nTwo'],
      ['<span class="md-bold">One<br></span><span>Two</span>', 'One\nTwo'],
      ['<div><span>One<br></span>Two</div>', 'One\nTwo'],
      ['<span style="font-size:36px"><b># Plain paste proof</b></span><div><span><b><br></b></span></div><div><span><b>Two separate paragraphs.</b></span></div><div><span><b><br></b></span></div><div>Finished after recovery.</div>', '# Plain paste proof\n\nTwo separate paragraphs.\n\nFinished after recovery.'],
      ['One<div><br></div><div>Two</div>', 'One\n\nTwo'],
      ['<div>One<br></div><div>Two<br><br></div>', 'One\nTwo\n'],
    ]) {
      await original.editHtml(html);
      assert.equal(original.readDocument(), text, 'browser block/BR line boundaries survive input and highlighter');
    }
    const editedText = '# Client note — ÆØÅ\n\nThis change was made before the snapshot.\n\n**Actual upstream editor** keeps markup and Unicode 📝.\n';
    assert.equal(await original.paste(editedText, { replace: true }), true);
    assert.equal(original.article.textContent, editedText);
    assert.ok(original.article.querySelector('.md-bold'));

    const text = captureText(original.readDocument());
    assert.throws(() => captureText('x'.repeat(16385)), /TEXT_TOO_LARGE/);
    assert.throws(() => captureText('\ud800'), /TEXT_INVALID/);
    assert.throws(() => exportText(text, 'pdf'), /EXPORT_FORMAT_INVALID/);
    const env = await (await b('/api/config')).json();
    const auth = syntheticClient(b);
    credential = await createTextReserveCredential({ config: env.config, user: { name: 'local-text-test', displayName: 'Local text integration test' }, webAuthnClient: auth });
    const ready = await prepareTextReserve({ config: env.config, recoveryCredential: credential, text,
      store: createReserveHttpStore({ enrollmentToken: env.enrollmentToken, fetcher: b }), webAuthnClient: auth });
    assert.equal(ready.independentlyVerified, true); assert.equal(ready.text, text);
    credential.close(); original.close();
    await b('/api/primary', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"online":false}' });
    assert.equal((await a('/')).status, 503); assert.equal((await a('/api/config')).status, 503);
    const before = await (await b('/api/status')).json();
    // The child receives only B's origin, not text, locator, credential ID,
    // setup objects, local storage, account identity or key material.
    const recovered = await childRecovery(app.recoveryOrigin);
    assert.equal(recovered.recovered, text);
    assert.equal(recovered.exportsReadBack, true); assert.equal(recovered.upstreamTxtExportExecuted, true);
    assert.equal(recovered.noAccountModel, true);
    const after = await (await b('/api/status')).json();
    assert.equal(after.counts.primary, before.counts.primary);
    assert.equal(after.counts.writes, 1); assert.equal(after.counts.creates, 1);
    assert.equal(after.counts.assertions, before.counts.assertions + 1, 'text recovery needs one discovery assertion');
    const again = await childRecovery(app.recoveryOrigin);
    assert.equal(again.recovered, text, 'later edits did not overwrite the immutable snapshot');
    const page = await b('/'); assert.equal(page.status, 200);
    const pageText = await page.text(); assert.match(pageText, /contenteditable="plaintext-only"/);
    assert.match(pageText, /Text Reserve/); assert.match(pageText, /aria-label="Textarea menu"/);
    assert.doesNotMatch(pageText, /id="(?:client|brief|nextStep|title)"|Snapshot envelope/);
    assert.equal(original.historyWrites, 0); assert.equal(original.serviceWorkerRequests, 0);
    console.log(JSON.stringify({ success: true, mode: 'synthetic-loopback-http-plus-upstream-jsdom', installedPublicSdk: true,
      independentlyAuthoredUpstream: 'antonmedv/textarea@8aa2247e4d92d963059e8788624e0c0d1be8d6a3',
      actualUpstreamEditorExecuted: true, exactTextPreserved: true, noAccountModel: true, editBeforeSnapshotPreserved: true,
      plainTextPastePreserved: true, blockDomLineBreaksPreserved: true, pasteUndoVerified: true,
      selectAllPasteTerminalNewlinePreserved: true, upstreamTxtExportExecuted: true, exportsReadBack: true,
      editedExportVerified: true, freshRecoveryProcess: true, oldEditorClosed: true,
      original503: true, originalRequestsDuringRecovery: 0, immutableSnapshotVerified: true,
      storedRecords: after.records, writes: after.counts.writes,
      nativePasskeys: false, physicalBrowser: false, upstreamAdoption: false, independentDeveloperFeedback: false }));
  } finally { credential?.close(); original.close(); await app.close(); }
}
if (process.argv[2] === '--fresh-recovery') await freshRecovery(process.argv[3]);
else await run();
