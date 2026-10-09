import test from 'node:test';
import assert from 'node:assert/strict';
import { createSelfServiceHostedClient } from '../self-service/backend/host.mjs';
import { selfServiceConfig, selfServiceTextConfig } from '../self-service/backend/profile.mjs';
const now = Date.UTC(2026, 9, 9);
const profile = { version: 1, enabled: true, releaseId: '7'.repeat(32),
  primaryOrigin: 'https://text-a.example.test', recoveryOrigin: 'https://text-b.example.test',
  expiresAt: '2026-11-10T00:00:00.000Z' };
const env = { DB: { prepare() { throw Error('read-only route touched DB'); }, batch() { throw Error('read-only route touched DB'); } } };
const assets = Object.fromEntries([['/index.html','legacy'],['/text/index.html','text']].map(([key,value]) => [key,{base64:btoa(value),contentType:'text/html'}]));
for (const role of ['primary','recovery']) {
  test(`${role} preserves Work routes and adds distinct wallet-free text configuration`, async () => {
    const host = createSelfServiceHostedClient({profile,role,assets},{now:()=>now});
    const origin = role === 'primary' ? profile.primaryOrigin : profile.recoveryOrigin;
    const old = await host.fetch(new Request(origin+'/api/config'),env);
    assert.equal(old.status,200);
    const legacy = await old.json(); assert.deepEqual(legacy.config,selfServiceConfig(profile));
    const current = await host.fetch(new Request(origin+'/api/text-config'),env);
    assert.equal(current.status,200);
    const text = await current.json(); assert.deepEqual(text.config,selfServiceTextConfig(profile));
    assert.deepEqual(Object.keys(text.config).sort(),['appId','recoveryOrigin','recoveryRpId']);
    assert.deepEqual(text.limits,legacy.limits); assert.equal(text.expiresAt,legacy.expiresAt);
    for (const [path,expected] of [['/','legacy'],['/text/','text'],['/text','text']]) {
      const response=await host.fetch(new Request(origin+path),env);
      assert.equal(response.status,200); assert.equal(await response.text(),expected);
      assert.match(response.headers.get('content-security-policy'),/connect-src 'self'/);
    }
    for (const path of ['/api/text-config?override=x','/api/text-config/','/api/text-config/key']) {
      assert.equal((await host.fetch(new Request(origin+path),env)).status,404);
    }
    assert.equal((await host.fetch(new Request(origin+'/api/text-config',{method:'POST'}),env)).status,405);
    assert.equal((await host.fetch(new Request('https://other.example.test/api/text-config'),env)).status,421);
  });
}
test('text mode obeys the existing public expiry and recovery DB requirement', async () => {
  const live=createSelfServiceHostedClient({profile,role:'recovery',assets},{now:()=>now});
  assert.equal((await live.fetch(new Request(profile.recoveryOrigin+'/api/text-config'))).status,503);
  const ended=createSelfServiceHostedClient({profile,role:'recovery',assets},{now:()=>Date.parse(profile.expiresAt)});
  for(const path of ['/text/','/api/text-config'])assert.equal((await ended.fetch(new Request(profile.recoveryOrigin+path),env)).status,410);
});
