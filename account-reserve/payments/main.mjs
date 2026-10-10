import './style.css';
import '../starter/prism-art.css';
import {createSecp256k1SigningSession} from '@category-labs/mera';
import {toViemAccount} from '@category-labs/mera/viem';
import {openPrimaryKey} from '../app-session.mjs';
import {recoverReserve} from '../sdk/index.mjs';
import {createReserveHttpStore} from '../release/browser-store.mjs';
import {validateClientProfile} from '../release/client-profile.mjs';
import {validatePaymentProfile} from './guard.mjs';
import {createTestnetPaymentClient,createTestnetPaymentReader,createTestnetPaymentVerifier,createTestnetPaymentAvailability} from './index.mjs';
import {mountPaymentPage} from './page.mjs';
const root=document.getElementById('app');
let bootDead=false;const bootAbort=new AbortController();
const bootHide=()=>{bootDead=true;bootAbort.abort();};
const bootShow=e=>{if(e.persisted)location.reload();};
window.addEventListener('pagehide',bootHide);window.addEventListener('pageshow',bootShow);
try{
  const get=async path=>{const r=await fetch(path,{cache:'no-store',credentials:'omit',redirect:'error',signal:bootAbort.signal});if(!r.ok)throw new Error('PAYMENT_CONFIG_UNAVAILABLE');return r.json();};
  const [env,input]=await Promise.all([get('/api/config'),get('/payments/profile.json')]);
  if(bootDead)throw new Error('PAYMENT_PAGE_CLOSED');
  const release=validateClientProfile(env.releaseProfile,{allowExpired:true});
  const profile=validatePaymentProfile({...input,claims:input.claims.map(c=>({...c,rightId:BigInt(c.rightId),amount:BigInt(c.amount)}))});
  if(env.hosted!==true||env.physicalEnabled!==true||!['primary','recovery'].includes(env.role)||location.origin!==(env.role==='primary'?release.primaryOrigin:release.recoveryOrigin))throw new Error('PAYMENT_ORIGIN_MISMATCH');
  const config={appId:release.namespace+'-iris',originalRpId:new URL(release.primaryOrigin).hostname,recoveryRpId:new URL(release.recoveryOrigin).hostname,derivation:'iris:prf-direct:v1'};
  mountPaymentPage(root,{role:env.role,profile,
    async openAccount({signal}){
      if(Date.now()>=Date.parse(profile.expiresAt))throw Object.assign(new Error(),{code:'PAYMENT_PROFILE_EXPIRED'});
      if(env.role==='recovery')return recoverReserve({config,store:createReserveHttpStore(),signal});
      const key=await openPrimaryKey({create:false,model:'iris',rpId:config.originalRpId,signal});
      let session;try{session=createSecp256k1SigningSession({privateKey:key});const account=toViemAccount(session);return {owner:account.address,account,close:()=>session.end()};}catch(e){session?.end();throw e;}finally{key.fill(0);}
    },
    createClient:recovered=>createTestnetPaymentClient({profile,recovered}),createReader:()=>createTestnetPaymentReader({profile}),createVerifier:()=>createTestnetPaymentVerifier({profile}),createAvailability:()=>createTestnetPaymentAvailability({profile}),
  });
}catch{if(!bootDead)root.innerHTML='<main class="payment-shell"><h1>Payment demonstration unavailable.</h1><p>Keep your existing passkeys. No credential or transaction was requested.</p></main>';}
finally{if(!bootDead){window.removeEventListener('pagehide',bootHide);window.removeEventListener('pageshow',bootShow);}}
