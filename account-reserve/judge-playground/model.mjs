import { hexToBytes } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createWorkReserveCredential, prepareWorkReserve, recoverWorkReserve, WORK_SCHEMA, validateWork } from './vendor/work-reserve.mjs';

export const example = Object.freeze({ schema: WORK_SCHEMA, title: 'A calmer checkout', client: 'Studio North', brief: 'Make buying a handmade chair feel as considered as the chair itself. Keep the copy calm, direct and useful.', deliverable: 'ADDRESS ERROR\nPlease add your street and house number so your chair finds its way home.\n\nORDER CONFIRMATION\n[Finish this message after recovering the draft.]', nextStep: 'Finish the confirmation message, then export the handoff.' });
const same = (a,b) => a.length === b.length && a.every((x,i)=>x===b[i]);
const encoder = new TextEncoder();

/** Browser-local demonstration only. A synthetic HMAC oracle replaces WebAuthn.
 * The unchanged Work SDK performs the encryption, discovery and verification.
 * No credentials, records or account keys are persisted or sent to a server. */
export async function createPlayground() {
  const seed = crypto.getRandomValues(new Uint8Array(32));
  let oracle = await crypto.subtle.importKey('raw', seed, { name:'HMAC', hash:'SHA-256' }, false, ['sign']);
  seed.fill(0);
  const id = crypto.getRandomValues(new Uint8Array(24));
  const config = { appId:'playground-'+crypto.randomUUID(), originalRpId:'example-original.invalid', recoveryRpId:'example-reserve.invalid', derivation:'fictional-work-demo:v1' };
  let primary = {...example}, phase = 'draft', owner, ready, context, disposed=false, active=false;
  const records = new Map();
  const counts = { create:0, assertions:0, storeReads:0, storeWrites:0 };
  const check = () => { if(disposed) throw new Error('SESSION_CLOSED'); };
  const output = async salt => { check(); const result=new Uint8Array(await crypto.subtle.sign('HMAC',oracle,salt)); check(); return result; };
  const client = {
    async createCredential(req) { check(); if(req.rp.id!==config.recoveryRpId) throw new Error('RP_MISMATCH'); counts.create++; return {credentialId:new Uint8Array(id),prfEnabled:true,prfOutput:await output(req.prfSalt),transports:['internal']}; },
    async getCredential(req) { check(); if(req.rpId!==config.recoveryRpId || req.allowCredential && !same(req.allowCredential.credentialId,id)) throw new Error('CREDENTIAL_MISMATCH'); counts.assertions++; return {credentialId:new Uint8Array(id),prfOutput:await output(req.prfSalt)}; },
  };
  const reader = {async get(key) {check(); counts.storeReads++; const value=records.get(key); return value && new Uint8Array(value);}};
  const store = {...reader,async putIfAbsent(key,value) {check(); counts.storeWrites++; if(records.has(key)) return false; records.set(key,new Uint8Array(value)); return true;}};
  const exclusively = async action => { check(); if(active) throw new Error('ACTION_PENDING'); active=true; try{return await action();}finally{active=false;} };
  const report = () => ({mode:'browser-local simulation',phase,originalAvailable:!!primary,recordCount:records.size,encryptedBytes:[...records.values()].reduce((sum,v)=>sum+v.length,0),workDigest:ready?.workDigest,accountSigning:'locked',nativePasskeys:false,blockchainTransactions:0,counts:{...counts}});
  return Object.freeze({
    report,
    readPrimary() {check(); if(!primary) throw new Error('PRIMARY_UNAVAILABLE'); return {...primary};},
    prepare(work) {return exclusively(async()=>{
      if(phase!=='draft') throw new Error('ALREADY_PREPARED');
      primary={...validateWork(work)};
      const keyText=generatePrivateKey(), key=hexToBytes(keyText);
      owner=privateKeyToAccount(keyText).address.toLowerCase();
      let credential;
      try { credential=await createWorkReserveCredential({config,user:{name:'Fictional visitor',displayName:'Fictional visitor'},webAuthnClient:client}); ready=await prepareWorkReserve({privateKey:key,policy:{...config,expectedOwner:owner},recoveryCredential:credential,work:primary,store,webAuthnClient:client}); check(); phase='prepared'; return report(); }
      finally { key.fill(0); credential?.close(); }
    });},
    takeOffline() {check(); if(active||phase!=='prepared') throw new Error('PREPARE_FIRST'); primary=undefined; phase='offline'; return report();},
    recover() {return exclusively(async()=>{
      if(phase!=='offline') throw new Error('TAKE_ORIGINAL_OFFLINE_FIRST');
      // A new context gets only public config, a ciphertext reader and the
      // surviving simulated authenticator. It never reads the primary draft.
      const recovered=await recoverWorkReserve({config:{...config},store:{get:reader.get},webAuthnClient:client});
      try {check(); if(recovered.owner!==owner || recovered.workDigest!==ready.workDigest) throw new Error('RECOVERY_MISMATCH'); context=recovered; phase='recovered'; return {...recovered.work};}
      catch(error) {recovered.close(); throw error;}
    });},
    rejectDamagedCopy() {return exclusively(async()=>{
      if(!ready) throw new Error('PREPARE_FIRST');
      const damagedReader={async get(key) {const bytes=await reader.get(key); const record=JSON.parse(new TextDecoder().decode(bytes)); record.ciphertext=(record.ciphertext[0]==='A'?'B':'A')+record.ciphertext.slice(1); return encoder.encode(JSON.stringify(record));}};
      try { const opened=await recoverWorkReserve({config,store:damagedReader,webAuthnClient:client}); opened.close(); throw new Error('DAMAGED_COPY_ACCEPTED'); }
      catch(error) { if(!['MANIFEST_AUTH_FAILED','RECORD_INVALID'].includes(error.code)) throw error; return {rejected:true,code:error.code}; }
    });},
    exportWork(work,format='txt') {check(); if(phase!=='recovered') throw new Error('RECOVER_FIRST'); const clean=validateWork(work); if(format==='json') return JSON.stringify(clean,null,2)+'\n'; return `${clean.title}\nClient: ${clean.client}\n\nBRIEF\n${clean.brief}\n\nWORKING DRAFT\n${clean.deliverable}\n\nNEXT STEP\n${clean.nextStep}\n`;},
    dispose() {disposed=true; phase='closed'; ready=undefined; owner=undefined; context?.close(); context=undefined; primary=undefined; for(const bytes of records.values()) bytes.fill(0); records.clear(); id.fill(0); oracle=undefined;},
  });
}
