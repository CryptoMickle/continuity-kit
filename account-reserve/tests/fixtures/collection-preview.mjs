import '../../self-service/apps/style.css';
import { mountTextReserveCollection } from '../../self-service/apps/collection.mjs';

// Local browser QA only. This file is outside every production build entrypoint.
const apps = [{ id: 'textarea', label: 'Textarea', config: { appId: 'continuity-textarea-v1', recoveryOrigin: location.origin, recoveryRpId: location.hostname } },
  { id: 'markdown', label: 'Markdown Studio', config: { appId: 'continuity-markdown-v1', recoveryOrigin: location.origin, recoveryRpId: location.hostname } }];
const texts = ['A CALMER CHECKOUT — FICTIONAL DRAFT\n\nKeep delivery costs visible before the final step. Let people check out as guests.\n\nStill to finish: write a calm confirmation message.', '# A quieter release\n\nA separate draft in Markdown Studio.\n\n- Explain the improvement\n- Thank the people who reported the issue\n- Leave a clear next step'];
mountTextReserveCollection({ root: document.getElementById('app'), env: { apps }, expiresAtMs: Date.now() + 86400000, lifetime: new AbortController(), dependencies: {
  makeStore() { return { get() { throw new Error('LOCAL_PREVIEW_HAS_NO_REMOTE_STORE'); } }; },
  async recover() { return apps.map((app, index) => ({ appId: app.config.appId, status: 'recovered', reserve: { protocol: 'account-continuity/text-reserve-v1', text: texts[index], textDigest: 'a'.repeat(64), locator: 'A'.repeat(43) } })); },
  loadEditor(id) { return import(/* @vite-ignore */ new URL('../../dist-self-service-apps/apps/editors/' + (id === 'textarea' ? 'textarea' : 'easymde') + '-editor.mjs', import.meta.url).href); },
} });
