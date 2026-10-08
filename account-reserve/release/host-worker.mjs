import {createReserveHandler} from './handler.mjs';
import {createRedisRestCommand} from './redis-rest.mjs';
import {validateClientProfile, PAYMENT_RIGHT_ABI} from './client-profile.mjs';

const security={
  'cache-control':'no-store', 'x-content-type-options':'nosniff', 'referrer-policy':'no-referrer',
  'permissions-policy':'camera=(), microphone=(), geolocation=()',
};
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{...security,'content-type':'application/json'}});
const unavailable=()=>json({error:'ACCOUNT_RESERVE_NOT_RELEASED'},503);

// Build-time public profile and assets only. Redis credentials and ticket hashes
// are runtime server bindings. No route receives private account keys.
export function createHostedClient({profile,role,assets,redisOrigin}){
  if(!['primary','recovery'].includes(role))throw new Error('HOST_ROLE_INVALID');
  if(profile?.enabled!==true)return {fetch:async()=>unavailable()};
  const handlers=new WeakMap();
  function reserveHandler(env,trusted){
    if(handlers.has(env))return handlers.get(env);
    if(env.RESERVE_REDIS_REST_URL!==redisOrigin)throw new Error('REDIS_ORIGIN_MISMATCH');
    const command=createRedisRestCommand({url:redisOrigin,token:env.RESERVE_REDIS_REST_TOKEN,allowedOrigins:[redisOrigin]});
    const enrollmentTickets=JSON.parse(env.RESERVE_ENROLLMENT_TICKET_HASHES??'[]');
    const storeProfile={version:1,enabled:true,releaseId:trusted.namespace.slice('account-reserve-'.length),recoveryOrigin:trusted.recoveryOrigin,expiresAt:trusted.expiresAt};
    const handler=createReserveHandler({profile:storeProfile,allowedOrigins:[trusted.recoveryOrigin],command,enrollmentTickets});
    handlers.set(env,handler);return handler;
  }
  return {
    async fetch(request,env={}){
      // Deployed Workers may expose an epoch-zero clock during module startup.
      // Validate against request time without weakening the release window.
      const now=Date.now();let trusted;
      try{trusted=validateClientProfile(profile,{now,allowExpired:true});}catch{return unavailable();}
      const expectedOrigin=role==='primary'?trusted.primaryOrigin:trusted.recoveryOrigin;
      const url=new URL(request.url);
      if(url.origin!==expectedOrigin)return json({error:'HOST_REJECTED'},421);
      if(now>=Date.parse(trusted.expiresAt))return json({error:'DEMONSTRATION_ENDED'},410);
      if(role==='primary'&&env.ACCOUNT_RESERVE_PRIMARY_OFFLINE==='true')return json({error:'PRIMARY_OFFLINE'},503);
      if(url.pathname.startsWith('/api/reserve/')&&role==='recovery'){
        try{return await reserveHandler(env,trusted)(request);}catch{return json({error:'STORE_UNAVAILABLE'},503);}
      }
      if(request.method!=='GET')return json({error:'METHOD_BLOCKED'},405);
      if(url.pathname==='/api/config'){
        if(role==='recovery'){try{reserveHandler(env,trusted);}catch{return json({error:'STORE_CONFIGURATION_UNAVAILABLE'},503);}}
        return json({hosted:true,physicalEnabled:true,role,primaryOrigin:trusted.primaryOrigin,recoveryOrigin:trusted.recoveryOrigin,chainId:10143,contractAddress:trusted.contractAddress,abi:PAYMENT_RIGHT_ABI,releaseProfile:trusted});
      }
      if(url.pathname.startsWith('/api/')||url.pathname==='/rpc'||url.pathname.startsWith('/control/'))return json({error:'ROUTE_UNAVAILABLE'},404);
      const path=url.pathname==='/'?'/index.html':url.pathname;
      const asset=assets[path];
      if(!asset)return json({error:'NOT_FOUND'},404);
      const bytes=Uint8Array.from(atob(asset.base64),c=>c.charCodeAt(0));
      const headers={...security,'content-type':asset.contentType,'content-security-policy':`default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' ${trusted.rpcUrls.join(' ')}; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`};
      return new Response(bytes,{headers});
    },
  };
}
