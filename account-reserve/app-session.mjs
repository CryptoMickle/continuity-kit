import {createPasskeyWithPrfOutput, getPasskeyPrfOutput} from '@category-labs/mera';
import {entropyToMnemonic, mnemonicToSeedSync} from '@scure/bip39';
import {wordlist} from '@scure/bip39/wordlists/english.js';
import {HDKey} from '@scure/bip32';
import {createWebAuthnScope} from './sdk/webauthn-scope.mjs';

// Example-account derivation only. The caller owns the returned key and must
// close its signing session on pagehide, expiry, or completed handover.
export async function openPrimaryKey({create=false, model, rpId, webAuthnClient, signal}) {
  const scope=createWebAuthnScope({webAuthnClient,signal});
  let salt, credential, key, seed, master, leaf;
  try {
    scope.assertActive();
    if(model==='iris')salt=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode('iris.account.v1')));
    else if(model!=='accrue')throw new Error('MODEL_INVALID');
    scope.assertActive();
    const options={...(salt?{prfSalt:salt}:{}),webAuthnClient:scope.client};
    credential=create
      ?await createPasskeyWithPrfOutput({...options,rp:{id:rpId,name:'Continuity example app'},user:{name:`Example ${model} ${new Date().toISOString()}`,displayName:`Example ${model} account`}})
      :await getPasskeyPrfOutput({...options,rpId});
    scope.assertActive();
    if(model==='iris')key=new Uint8Array(credential.prfOutput);
    else {
      seed=mnemonicToSeedSync(entropyToMnemonic(credential.prfOutput,wordlist));
      master=HDKey.fromMasterSeed(seed);leaf=master.derive("m/44'/60'/0'/0/1");
      key=new Uint8Array(leaf.privateKey);
    }
    scope.assertActive();
    const result=key;key=undefined;return result;
  } catch(error) { scope.assertActive();throw error; } finally {
    key?.fill(0);credential?.prfOutput.fill(0);credential?.prfSalt?.fill(0);
    salt?.fill(0);seed?.fill(0);master?.wipePrivateData();leaf?.wipePrivateData();scope.close();
  }
}
