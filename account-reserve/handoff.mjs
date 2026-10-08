export function validHandoff(event,{origin,source,nonce,phase,expiresAt},kind){
  const d=event.data;
  return Date.now()<expiresAt&&phase==='waiting'&&event.origin===origin&&event.source===source&&d?.version===1&&d.nonce===nonce&&d.kind===kind&&Object.keys(d).sort().join(',')==='kind,nonce,version';
}
export function randomNonce(){return Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,'0')).join('');}
