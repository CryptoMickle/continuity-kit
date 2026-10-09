import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { privateKeyToAccount } from 'viem/accounts';
import { createWorkReserveCredential, prepareWorkReserve, recoverWorkReserve } from '@continuitykit/account-reserve/work-reserve';
import { createReserveHttpStore } from '@continuitykit/account-reserve/http-store';
import { startIntegration } from './server.mjs';
import { loopbackFetch } from './loopback-fetch.mjs';
import { syntheticClient } from './synthetic-client.mjs';
import { captureWork, restoreWork, exportWork } from './adapter.mjs';
import { createEditorTestHost } from './editor-test-host.mjs';

async function freshRecovery(origin) {
  const fetcher = loopbackFetch(origin);
  const env = await (await fetcher('/api/config')).json();
  assert.equal(env.enrollmentToken, undefined, 'recovery gets no enrollment capability');
  const host = await createEditorTestHost(origin);
  const store = createReserveHttpStore({ fetcher });
  const opened = await recoverWorkReserve({ config: env.config, store, webAuthnClient: syntheticClient(fetcher) });
  try {
    let metadata;
    restoreWork(opened.work, host.editor, value => { metadata = value; });
    assert.equal(host.article.textContent, opened.work.deliverable);
    assert.ok(host.article.querySelector('.md-h1'), 'actual upstream highlighter ran');
    assert.equal('account' in opened, false, 'work-only result is not a signer');
    const original = captureWork(host.readDocument(), metadata);
    assert.equal(await host.paste('\n\nRecovered editor: final sentence completed.'), true);
    const exported = JSON.parse(exportWork(host.readDocument(), metadata));
    assert.equal(exported.deliverable.endsWith('final sentence completed.'), true);
    assert.equal(exported.brief, original.brief);
    assert.equal(host.historyWrites, 0); assert.equal(host.serviceWorkerRequests, 0);
    console.log(JSON.stringify({ owner: opened.owner, recovered: original, editedExport: exported,
      upstreamEditorRendered: true, upstreamEditPathExercised: true, signingStayedLocked: true,
      plaintextUrlWrites: host.historyWrites, serviceWorkerRequests: host.serviceWorkerRequests }));
  } finally { opened.close(); host.close(); }
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
  const app = await startIntegration({ primaryPort: 5573, recoveryPort: 5574 });
  const original = await createEditorTestHost(app.originalOrigin);
  const a = loopbackFetch(app.originalOrigin), b = loopbackFetch(app.recoveryOrigin);
  let key, credential;
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
    const metadata = { title: 'Independent editor handoff', client: 'Fictional studio', brief: 'Keep every field, including line breaks.\nSecond line.', nextStep: 'Write the final sentence in the recovered editor.' };
    const work = captureWork(original.readDocument(), metadata);
    assert.throws(() => captureWork(editedText, { ...metadata, silentlyDropped: 'no' }), /EDITOR_ENVELOPE_INVALID/);
    assert.throws(() => captureWork('x'.repeat(17000), metadata), /WORK_TOO_LARGE/);
    const env = await (await b('/api/config')).json();
    const auth = syntheticClient(b);
    key = crypto.getRandomValues(new Uint8Array(32));
    const owner = privateKeyToAccount('0x' + Buffer.from(key).toString('hex')).address.toLowerCase();
    credential = await createWorkReserveCredential({ config: env.config, user: { name: 'local-test', displayName: 'Local integration test' }, webAuthnClient: auth });
    const ready = await prepareWorkReserve({ privateKey: key, policy: { ...env.config, expectedOwner: owner }, recoveryCredential: credential, work,
      store: createReserveHttpStore({ enrollmentToken: env.enrollmentToken, fetcher: b }), webAuthnClient: auth });
    assert.equal(ready.independentlyVerified, true);
    key.fill(0); credential.close(); original.close();
    await b('/api/primary', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"online":false}' });
    assert.equal((await a('/')).status, 503); assert.equal((await a('/api/config')).status, 503);
    const before = await (await b('/api/status')).json();
    // Only B's origin is passed. No work, owner, locator, key, credential ID,
    // original document or setup object is supplied to the fresh OS process.
    const recovered = await childRecovery(app.recoveryOrigin);
    assert.deepEqual(recovered.recovered, work);
    assert.equal(recovered.owner, owner);
    const after = await (await b('/api/status')).json();
    assert.equal(after.counts.primary, before.counts.primary);
    assert.equal(after.counts.writes, 1); assert.equal(after.counts.creates, 1);
    assert.equal(after.counts.assertions, before.counts.assertions + 1, 'work recovery uses discovery without account unlock');
    // A second genuinely new process proves recovered edits did not overwrite reserve.
    const again = await childRecovery(app.recoveryOrigin);
    assert.deepEqual(again.recovered, work);
    const page = await b('/'); assert.equal(page.status, 200);
    const pageText = await page.text(); assert.match(pageText, /contenteditable="plaintext-only"/);
    assert.match(pageText, /Snapshot envelope added by this adapter/);
    assert.match(pageText, /aria-label="Textarea menu"/);
    assert.equal(original.historyWrites, 0); assert.equal(original.serviceWorkerRequests, 0);
    console.log(JSON.stringify({ success: true, mode: 'synthetic-loopback-http-plus-upstream-jsdom', installedPublicSdk: true,
      independentlyAuthoredUpstream: 'antonmedv/textarea@8aa2247e4d92d963059e8788624e0c0d1be8d6a3',
      actualUpstreamEditorExecuted: true, allFiveFieldsPreserved: true, editBeforeSnapshotPreserved: true,
      plainTextPastePreserved: true, blockDomLineBreaksPreserved: true, pasteUndoVerified: true,
      selectAllPasteTerminalNewlinePreserved: true,
      editedExportVerified: true, freshRecoveryProcess: true, oldEditorClosed: true,
      original503: true, originalRequestsDuringRecovery: 0, immutableSnapshotVerified: true,
      storedRecords: after.records, writes: after.counts.writes, signingStayedLockedDuringRecovery: true,
      nativePasskeys: false, physicalBrowser: false, upstreamAdoption: false, independentDeveloperFeedback: false }));
  } finally { key?.fill(0); credential?.close(); original.close(); await app.close(); }
}
if (process.argv[2] === '--fresh-recovery') await freshRecovery(process.argv[3]);
else await run();
