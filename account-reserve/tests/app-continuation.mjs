import assert from 'node:assert/strict';
import {test} from 'node:test';
import {privateKeyToAccount} from 'viem/accounts';
import {makeSdkFixture} from './sdk-fixture.mjs';
import {prepareOrConfirmReserve} from '../app-setup.mjs';
import {openPrimaryKey} from '../app-session.mjs';

test('existing reserve continuation confirms the same account without another immutable write or new key', async()=>{
  const f=makeSdkFixture();
  try {
    await f.prepare();const before=f.stats();
    const ready=await f.prepare({},options=>prepareOrConfirmReserve(options,true));
    assert.equal(ready.status,'ready');assert.equal(ready.owner,f.policy.expectedOwner);
    assert.equal(f.store.calls.put,1);assert.equal(f.stats().creates,before.creates);
  } finally {f.cleanup();}
});

test('continuation cannot bind an existing reserve to a different primary account', async()=>{
  const f=makeSdkFixture();const key=new Uint8Array(32).fill(7);
  try {
    await f.prepare();
    const owner=privateKeyToAccount('0x'+Buffer.from(key).toString('hex')).address.toLowerCase();
    await assert.rejects(()=>f.prepare({privateKey:key,policy:{...f.policy,expectedOwner:owner}},options=>prepareOrConfirmReserve(options,true)),{code:'OWNER_MISMATCH'});
    assert.equal(f.store.calls.put,1);
  } finally {key.fill(0);f.cleanup();}
});

test('uncertain write is not retried or silently declared ready during continuation', async()=>{
  const f=makeSdkFixture();let puts=0;
  try {
    const store={get:locator=>f.store.get(locator),async putIfAbsent(locator,bytes){puts++;await f.store.putIfAbsent(locator,bytes);throw new Error('response lost');}};
    await assert.rejects(()=>f.prepare({store},options=>prepareOrConfirmReserve(options,true)),{code:'STORE_WRITE_UNKNOWN'});
    assert.equal(puts,1);
    const recovered=await f.recover();assert.equal(recovered.owner,f.policy.expectedOwner);recovered.close();
    assert.equal(puts,1);
  } finally {f.cleanup();}
});

test('retained recovery credential with no record can be deliberately prepared without creation', async()=>{
  const f=makeSdkFixture();
  try {const ready=await f.prepare({},options=>prepareOrConfirmReserve(options,true));assert.equal(ready.owner,f.policy.expectedOwner);assert.equal(f.stats().creates,0);assert.equal(f.store.calls.put,1);}
  finally {f.cleanup();}
});

for(const model of ['iris','accrue'])test(`existing ${model} primary key is stable; raw outputs are erased`,async()=>{
  const outputs=[];let created=0;
  const client={async createCredential(){created++;throw new Error('creation forbidden');},async getCredential(){const prfOutput=new Uint8Array(32).fill(31);outputs.push(prfOutput);return {credentialId:new Uint8Array([3,7,2]),prfOutput};}};
  const first=await openPrimaryKey({model,rpId:'primary.localhost',webAuthnClient:client});
  const second=await openPrimaryKey({model,rpId:'primary.localhost',webAuthnClient:client});
  try{assert.deepEqual(first,second);assert.equal(created,0);assert.ok(outputs.every(output=>output.every(byte=>byte===0)));}
  finally{first.fill(0);second.fill(0);}
});

test('late primary result after page cancellation cannot install a signing key',async()=>{
  const controller=new AbortController();let complete,started;
  const waiting=new Promise(resolve=>{started=resolve;});
  const client={async createCredential(){throw new Error('not used');},getCredential(){started();return new Promise(resolve=>{complete=resolve;});}};
  const pending=openPrimaryKey({model:'iris',rpId:'primary.localhost',webAuthnClient:client,signal:controller.signal});
  await waiting;controller.abort();await assert.rejects(pending);
  const late=new Uint8Array(32).fill(19);complete({credentialId:new Uint8Array([1,2,3]),prfOutput:late});
  await new Promise(resolve=>setImmediate(resolve));assert.ok(late.every(byte=>byte===0));
});
