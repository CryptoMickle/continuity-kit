import {validatePaymentProfile} from './guard.mjs';
const TYPES=new Set(['text/html; charset=utf-8','text/javascript; charset=utf-8','text/css; charset=utf-8']);
export function createPaymentSiteHandler({legacy,origin,role,profile:input,assets}){
 if(typeof legacy?.fetch!=='function'||!['primary','recovery'].includes(role)||new URL(origin).origin!==origin||!origin.startsWith('https://'))throw new Error('PAYMENT_SITE_INVALID');
 const profile=validatePaymentProfile({...input,claims:input.claims.map(c=>({...c,rightId:BigInt(c.rightId),amount:BigInt(c.amount)}))});
 const encoded=JSON.stringify(profile,(_,v)=>typeof v==='bigint'?String(v):v);
 const files=new Map();
 for(const [path,asset]of Object.entries(assets)){
  if(!/^\/payments\/(?:index\.html|assets\/[A-Za-z0-9_-]+\.(?:js|css))$/.test(path)||!TYPES.has(asset.contentType)||typeof asset.base64!=='string'||asset.base64.length>3000000)throw new Error('PAYMENT_ASSET_INVALID');
  files.set(path,Object.freeze({...asset}));
 }
 const headers={'cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer','permissions-policy':'camera=(), microphone=(), geolocation=()','content-security-policy':"default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' https://testnet-rpc.monad.xyz https://rpc-testnet.monadinfra.com; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"};
 return {async fetch(request,env,ctx){
  const url=new URL(request.url);
  // Preserve the complete existing application and storage adapter unchanged.
  if(url.pathname!=='/payments'&&!url.pathname.startsWith('/payments/'))return legacy.fetch(request,env,ctx);
  const response=(body,status=200,type='text/plain; charset=utf-8')=>new Response(request.method==='HEAD'?null:body,{status,headers:{...headers,'content-type':type}});
  if(url.origin!==origin)return response('Origin unavailable',404);
  if(role==='primary'&&env?.ACCOUNT_RESERVE_PRIMARY_OFFLINE==='true')return response('Original application unavailable',503);
  if(!['GET','HEAD'].includes(request.method))return response('Method unavailable',405);
  if(url.pathname==='/payments')return new Response(null,{status:308,headers:{...headers,location:'/payments/'}});
  if(url.pathname==='/payments/profile.json')return response(encoded,200,'application/json; charset=utf-8');
  const item=files.get(url.pathname==='/payments/'?'/payments/index.html':url.pathname);
  if(!item)return response('Not found',404);
  return response(Uint8Array.from(atob(item.base64),c=>c.charCodeAt(0)),200,item.contentType);
 }};
}
