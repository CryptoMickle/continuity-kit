import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createReserveProgress} from '../app-progress.mjs';
import {prepareOrConfirmReserve} from '../app-setup.mjs';
import {makeSdkFixture} from './sdk-fixture.mjs';

test('setup reports protection before assertions and independent verification only after confirmed storage',async()=>{
  const f=makeSdkFixture(),events=[];
  try{
    const ready=await f.prepare({onProgress:(...args)=>events.push({args,requests:f.stats().recoveryRequests,...f.store.calls})});
    assert.deepEqual(events,[
      {args:['protect-reserve'],requests:0,get:0,put:0},
      {args:['verify-reserve'],requests:2,get:2,put:1},
    ]);
    assert.equal(f.stats().recoveryRequests,4);
    assert.equal(ready.independentlyVerified,true);
  }finally{f.cleanup();}
});

test('recovery announces unlock only after discovery and stored manifest validation',async()=>{
  const f=makeSdkFixture(),events=[];
  try{
    await f.prepare();const before={requests:f.stats().recoveryRequests,get:f.store.calls.get};
    const recovered=await f.recover({onProgress:stage=>events.push({stage,requests:f.stats().recoveryRequests-before.requests,get:f.store.calls.get-before.get})});
    assert.deepEqual(events,[{stage:'find-reserve',requests:0,get:0},{stage:'unlock-reserve',requests:1,get:1}]);
    assert.equal(recovered.owner,f.policy.expectedOwner);recovered.close();
    const failed=[];
    await assert.rejects(()=>f.recover({store:{async get(){return new Uint8Array([1]);}},onProgress:stage=>failed.push(stage)}),{code:'RECORD_INVALID'});
    assert.deepEqual(failed,['find-reserve']);
  }finally{f.cleanup();}
});

test('existing-credential continuation reports its independent check without another write',async()=>{
  const f=makeSdkFixture(),events=[];
  try{
    await f.prepare();const before=f.stats();
    const ready=await f.prepare({onProgress:stage=>events.push(stage)},options=>prepareOrConfirmReserve(options,true));
    assert.deepEqual(events,['protect-reserve','verify-reserve']);
    assert.equal(f.store.calls.put,1);assert.equal(f.stats().creates,before.creates);
    assert.equal(ready.owner,f.policy.expectedOwner);
  }finally{f.cleanup();}
});

test('unconfirmed storage never announces independent verification or completion',async()=>{
  const f=makeSdkFixture(),events=[];let reads=0;
  try{
    await assert.rejects(()=>f.prepare({store:{
      get:locator=>++reads===1?f.store.get(locator):new Uint8Array([1]),
      putIfAbsent:(...args)=>f.store.putIfAbsent(...args),
    },onProgress:stage=>events.push(stage)}),{code:'READBACK_FAILED'});
    assert.deepEqual(events,['protect-reserve']);assert.equal(f.store.calls.put,1);
  }finally{f.cleanup();}
});

test('observer exceptions and rejected promises cannot change reserve checks',async()=>{
  for(const observer of [()=>{throw new Error('render failed');},()=>Promise.reject(new Error('render failed'))]){
    const f=makeSdkFixture();
    try{
      const ready=await f.prepare({onProgress:observer});
      const recovered=await f.recover({onProgress:observer});
      assert.equal(ready.independentlyVerified,true);assert.equal(recovered.owner,ready.owner);
      assert.equal(f.stats().recoveryRequests,6);assert.equal(f.store.calls.put,1);recovered.close();
    }finally{f.cleanup();}
  }
});

test('cancellation from a progress observer stops before another assertion and cannot complete the UI',async()=>{
  const f=makeSdkFixture(),controller=new AbortController(),views=[];
  const progress=createReserveProgress({kind:'setup',signal:controller.signal,onChange:view=>views.push(view)});
  try{
    await assert.rejects(()=>f.prepare({signal:controller.signal,onProgress:stage=>{
      progress.advance(stage);if(stage==='verify-reserve')controller.abort();
    }}),error=>error.code==='OPERATION_CANCELLED'&&error.recordMayExist===true);
    assert.equal(f.stats().recoveryRequests,2);assert.equal(f.store.calls.put,1);
    assert.equal(progress.complete(),false);assert.equal(progress.advance('verify-reserve'),false);
    assert.equal(views.at(-1).state,'stopped');assert.ok(views.every(view=>view.state!=='complete'));
    const recovered=await f.recover();assert.equal(recovered.owner,f.policy.expectedOwner);recovered.close();
  }finally{f.cleanup();}
});

test('recovery observer cancellation prevents the vault prompt and signer return',async()=>{
  const f=makeSdkFixture(),controller=new AbortController(),events=[];
  try{
    await f.prepare();const before=f.stats().recoveryRequests;
    await assert.rejects(()=>f.recover({signal:controller.signal,onProgress:stage=>{
      events.push(stage);if(stage==='unlock-reserve')controller.abort();
    }}),{code:'OPERATION_CANCELLED'});
    assert.deepEqual(events,['find-reserve','unlock-reserve']);assert.equal(f.stats().recoveryRequests-before,1);
  }finally{f.cleanup();}
});

test('visible progress requires ordered real stages and never advances after cancellation',()=>{
  const controller=new AbortController(),views=[];
  const progress=createReserveProgress({kind:'recovery',signal:controller.signal,onChange:view=>views.push(view)});
  assert.equal(progress.complete(),false);
  assert.equal(progress.advance('check-account'),false);
  assert.equal(progress.advance('find-reserve'),true);assert.equal(views.length,1);
  assert.equal(progress.advance('unlock-reserve'),true);
  assert.deepEqual(progress.snapshot().steps.map(step=>step.state),['complete','active','pending']);
  controller.abort();const stopped=progress.snapshot();
  assert.equal(progress.advance('check-account'),false);assert.equal(progress.complete(),false);
  assert.deepEqual(progress.snapshot(),stopped);assert.equal(stopped.steps[1].state,'stopped');
});

test('only a returned successful operation completes its last stage; terminal progress is stable',()=>{
  const controller=new AbortController();
  const progress=createReserveProgress({kind:'setup',useExisting:true,signal:controller.signal});
  progress.advance('protect-reserve');progress.advance('verify-reserve');
  assert.equal(progress.snapshot().state,'active');assert.equal(progress.complete(),true);
  controller.abort();assert.equal(progress.stop(),false);
  assert.ok(progress.snapshot().steps.every(step=>step.state==='complete'));
});
