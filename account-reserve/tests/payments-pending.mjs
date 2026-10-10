import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserPaymentPendingStore, paymentEntry, validatePaymentJournal, validatePaymentPolicy, MAX_PAYMENT_HISTORY } from '../payments/pending.mjs';

const owner = '0x' + '11'.repeat(20), address = '0x' + '22'.repeat(20);
const policy = (n = 0) => ({ chainId:31337,owner,address,rightId:BigInt(n+1),amount:100n,nonce:n,gas:100000n,maxFeePerGas:20n,maxPriorityFeePerGas:1n });
function fixture() {
  const values = new Map(), queues = new Map(), calls = [];
  const storage = { getItem:key=>values.get(key)??null, setItem:(key,value)=>{calls.push({key,value});values.set(key,value);} };
  const locks = { request(name, options, callback) { assert.deepEqual(options,{mode:'exclusive'}); const next = (queues.get(name)??Promise.resolve()).then(()=>callback({name,mode:'exclusive'})); queues.set(name,next.catch(()=>{})); return next; } };
  const make = (extra = {}) => createBrowserPaymentPendingStore({chainId:31337,owner,storage,locks,...extra});
  return {values,calls,storage,locks,make};
}
function journal(entries) { return {version:1,chainId:31337,owner,active:entries.at(-1).phase==='confirmed'?null:entries.length-1,entries}; }
const hash = n => '0x'+(n+1).toString(16).padStart(64,'0');
const signed = (entry,n=0) => ({...entry,phase:'signed',hash:hash(n)});
const confirmed = (entry,n=0) => ({...signed(entry,n),phase:'confirmed'});
const code = expected => error => error.code === expected && error.message === expected;

test('journal commits one write per strict transition and restores frozen public metadata only',async()=>{
  const f=fixture(),s=f.make(),e=paymentEntry(policy(),80000n);
  assert.equal(s.read(),undefined);
  assert.throws(()=>s.put(journal([e])),code('PAYMENT_LOCK_REQUIRED'));
  await s.withLock(async()=>{
    s.put(journal([e])); s.put(journal([signed(e)])); s.put(journal([confirmed(e)]));
    s.put(journal([confirmed(e),paymentEntry(policy(1),70000n)]));
  });
  assert.equal(f.calls.length,4); assert.equal(f.values.size,1);
  const restored=f.make().read(); assert.equal(restored.entries.length,2); assert.equal(restored.active,1);
  assert(Object.isFrozen(restored)&&Object.isFrozen(restored.entries)&&restored.entries.every(Object.isFrozen));
  assert.deepEqual(Object.keys(restored.entries[0]),['address','rightId','amount','nonce','gas','maxFeePerGas','maxPriorityFeePerGas','selectedGas','phase','hash']);
  assert(!f.calls[0].key.includes(address));
});

test('two stores for the account serialize across contracts while other accounts use another key',async()=>{
  const f=fixture(),a=f.make(),b=f.make(),events=[];
  let release;const hold=new Promise(resolve=>release=resolve);
  const first=a.withLock(async()=>{events.push('first');await hold;events.push('release');});
  const second=b.withLock(async()=>events.push('second'));
  await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(events,['first']);release();await Promise.all([first,second]);
  assert.deepEqual(events,['first','release','second']);
  await f.make({owner:'0x'+'33'.repeat(20)}).withLock(()=>{});
});

test('unfinished journals reject append, rewrite, downgrade and duplicate successful writes',async()=>{
  const f=fixture(),s=f.make(),e=paymentEntry(policy(),80000n);
  await s.withLock(()=>{
    s.put(journal([e]));
    for(const next of [journal([e]),journal([confirmed(e),paymentEntry(policy(1),80000n)]),journal([{...e,amount:'101'}]),journal([confirmed(e)])]) assert.throws(()=>s.put(next),code('PAYMENT_JOURNAL_CONFLICT'));
    s.put(journal([signed(e)]));
    assert.throws(()=>s.put(journal([e])),code('PAYMENT_JOURNAL_CONFLICT'));
    assert.throws(()=>s.put(journal([{...confirmed(e),hash:hash(4)}])),code('PAYMENT_JOURNAL_CONFLICT'));
  });assert.equal(f.calls.length,2);
});

test('canonical bounded journal rejects duplicates, wrong binding, aliases, accessors and malformed history',async()=>{
  const f=fixture(),s=f.make(),e=paymentEntry(policy(),80000n);
  await s.withLock(()=>s.put(journal([e])));const [key,raw]=[...f.values][0];
  for(const malformed of [' '+raw,raw.replace('"version":1','"version":1,"version":1'),'x'.repeat(131073),JSON.stringify({...journal([e]),owner:address}),JSON.stringify({...journal([e]),active:null}),JSON.stringify(journal([{...e,rightId:'01'}])),JSON.stringify(journal([confirmed(e),{...e,rightId:'2'}])),JSON.stringify(journal([confirmed(e),confirmed(paymentEntry(policy(1),80000n))]))]) {
    f.values.set(key,malformed);assert.throws(()=>s.read(),code('PAYMENT_JOURNAL_INVALID'));
  }
  let invoked=0;const bad={...journal([e])};Object.defineProperty(bad,'entries',{enumerable:true,get(){invoked++;return[e];}});
  assert.throws(()=>validatePaymentJournal(bad,{chainId:31337,owner}),code('PAYMENT_JOURNAL_INVALID'));assert.equal(invoked,0);
  const extra=[e];extra.extra=true;assert.throws(()=>validatePaymentJournal(journal(extra),{chainId:31337,owner}),code('PAYMENT_JOURNAL_INVALID'));
});

test('storage failure and silent lost writes fail closed, captured methods cannot be replaced',async()=>{
  const f=fixture(),s=f.make(),e=paymentEntry(policy(),80000n);
  f.storage.getItem=()=>{throw new Error('secret');}; f.storage.setItem=()=>{throw new Error('secret');};
  await s.withLock(()=>s.put(journal([e])));assert.equal(s.read().active,0);
  for(const storage of [{getItem(){throw new Error('private');},setItem(){}},{getItem(){return null;},setItem(){throw new Error('private');}}]) {
    const broken=f.make({storage});await assert.rejects(broken.withLock(()=>broken.put(journal([e]))),code('PAYMENT_STORE_UNAVAILABLE'));
  }
  const lost=f.make({storage:{getItem:()=>null,setItem(){}}});
  await assert.rejects(lost.withLock(()=>lost.put(journal([e]))),code('PAYMENT_STORE_READBACK_FAILED'));
});

test('missing, accessor or malformed lock providers never execute journal writes',async()=>{
  const f=fixture();let invoked=0;
  const locks={};Object.defineProperty(locks,'request',{get(){invoked++;return()=>{};}});
  assert.throws(()=>f.make({locks}),code('PAYMENT_LOCK_UNAVAILABLE'));assert.equal(invoked,0);
  for(const provider of [{request:async()=>{}},{request:async(name,o,cb)=>cb(null)},{request:async(name,o,cb)=>cb({name,mode:'shared'})}]) {
    const s=f.make({locks:provider});await assert.rejects(s.withLock(()=>invoked++),code('PAYMENT_LOCK_UNAVAILABLE'));
  } assert.equal(invoked,0);assert.equal(f.calls.length,0);
});

test('history is bounded without pruning completed intents or allowing reused nonces',async()=>{
  const f=fixture(),s=f.make();let entries=[];
  await s.withLock(()=>{
    for(let n=0;n<MAX_PAYMENT_HISTORY;n++) {
      const e=paymentEntry(policy(n),80000n);entries=[...entries,e];s.put(journal(entries));entries=[...entries.slice(0,-1),signed(e,n)];s.put(journal(entries));entries=[...entries.slice(0,-1),confirmed(e,n)];s.put(journal(entries));
    }
    assert.throws(()=>s.put(journal([...entries,paymentEntry(policy(64),80000n)])),code('PAYMENT_JOURNAL_INVALID'));
  });assert.equal(s.read().entries.length,64);
});

test('policy is copied and exact; non-test chains, invalid uints, getters and fee escalation are refused',()=>{
  const p=policy(),copy=validatePaymentPolicy(p);p.rightId=99n;assert.equal(copy.rightId,1n);assert(Object.isFrozen(copy));
  for(const change of [{chainId:1},{nonce:-1},{nonce:1.5},{rightId:0n},{amount:2n**256n},{gas:0n},{maxPriorityFeePerGas:21n},{extra:true},{address:owner}]) assert.throws(()=>validatePaymentPolicy({...policy(),...change}),code('PAYMENT_POLICY_INVALID'));
  let invoked=0;const getter=policy();Object.defineProperty(getter,'owner',{enumerable:true,get(){invoked++;return owner;}});
  assert.throws(()=>validatePaymentPolicy(getter),code('PAYMENT_POLICY_INVALID'));assert.equal(invoked,0);
  assert.throws(()=>paymentEntry(policy(),100001n),code('PAYMENT_GAS_INVALID'));
});
