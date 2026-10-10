import test from 'node:test';
import assert from 'node:assert/strict';
import { createSelfServiceHostedClient } from '../self-service/backend/host.mjs';
import { LIMITS, selfServiceAppsConfig, selfServiceConfig, selfServiceTextConfig } from '../self-service/backend/profile.mjs';
import { validateEnvironment } from '../self-service/apps/config.mjs';

const now = Date.UTC(2026, 9, 10);
const profile = { version: 1, enabled: true, releaseId: '8'.repeat(32), primaryOrigin: 'https://apps-a.example.test', recoveryOrigin: 'https://apps-b.example.test', expiresAt: '2026-11-10T00:00:00.000Z' };
const env = { DB: { prepare() { throw Error('Read-only routing must not issue SQL'); }, batch() { throw Error('Read-only routing must not issue SQL'); } } };
const assets = Object.fromEntries([
  ['/index.html', 'earlier Work'], ['/text/index.html', 'earlier text'], ['/apps/index.html', 'two editors'],
  ['/apps/editors/textarea-editor.mjs', 'textarea module'], ['/apps/editors/easymde-editor.mjs', 'markdown module'],
].map(([path, contents]) => [path, { base64: btoa(contents), contentType: path.endsWith('.mjs') ? 'text/javascript' : 'text/html' }]));

for (const role of ['primary', 'recovery']) {
  test(`${role} serves a fixed two-app config compatible with the strict client, sharing original limits`, async () => {
    const origin = role === 'primary' ? profile.primaryOrigin : profile.recoveryOrigin;
    const host = createSelfServiceHostedClient({ profile, role, assets }, { now: () => now });
    const response = await host.fetch(new Request(origin + '/api/apps-config'), env);
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    const config = await response.json();
    assert.deepEqual(config.apps, selfServiceAppsConfig(profile));
    assert.deepEqual(config.apps.map(app => app.config.appId), ['continuity-textarea-v1', 'continuity-markdown-v1']);
    assert.equal(new Set(config.apps.map(app => app.config.appId)).size, 2);
    assert.equal(config.operatorHosted, false); assert.equal(config.enrollmentRequiresInvitation, false);
    assert.deepEqual(config.limits, LIMITS); assert.equal(config.expiresAt, profile.expiresAt);
    for (const id of ['textarea', 'markdown']) assert.equal(validateEnvironment(config, origin + '/apps/' + id + '/', now).selected.id, id);
    const old = await (await host.fetch(new Request(origin + '/api/config'), env)).json();
    const text = await (await host.fetch(new Request(origin + '/api/text-config'), env)).json();
    assert.deepEqual(old.config, selfServiceConfig(profile)); assert.deepEqual(text.config, selfServiceTextConfig(profile));
    assert.deepEqual(config.limits, old.limits); assert.deepEqual(config.limits, text.limits);
    assert.equal(config.expiresAt, old.expiresAt); assert.equal(config.expiresAt, text.expiresAt);
    for (const [path, expected] of [['/', 'earlier Work'], ['/text/', 'earlier text'], ['/apps', 'two editors'], ['/apps/', 'two editors'], ['/apps/textarea/', 'two editors'], ['/apps/markdown', 'two editors'], ['/apps/editors/textarea-editor.mjs', 'textarea module'], ['/apps/editors/easymde-editor.mjs', 'markdown module']]) {
      const page = await host.fetch(new Request(origin + path), env); assert.equal(page.status, 200); assert.equal(await page.text(), expected);
      assert.match(page.headers.get('content-security-policy'), /connect-src 'self'/);
      assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
    }
    for (const path of ['/apps/unknown/', '/api/apps-config?appId=arbitrary', '/api/apps-config/', '/api/apps-config/key']) assert.equal((await host.fetch(new Request(origin + path), env)).status, 404);
    assert.equal((await host.fetch(new Request(origin + '/api/apps-config', { method: 'POST' }), env)).status, 405);
    assert.equal((await host.fetch(new Request('https://wrong.example.test/api/apps-config'), env)).status, 421);
  });
}

test('new app routes retain the original expiry and recovery database requirement', async () => {
  const live = createSelfServiceHostedClient({ profile, role: 'recovery', assets }, { now: () => now });
  assert.equal((await live.fetch(new Request(profile.recoveryOrigin + '/api/apps-config'))).status, 503);
  const ended = createSelfServiceHostedClient({ profile, role: 'recovery', assets }, { now: () => Date.parse(profile.expiresAt) });
  for (const path of ['/api/apps-config', '/apps/', '/apps/textarea/', '/apps/markdown/']) assert.equal((await ended.fetch(new Request(profile.recoveryOrigin + path), env)).status, 410);
});
