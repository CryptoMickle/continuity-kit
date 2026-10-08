import {keccak256, verifyMessage} from 'viem';
import {prepareReserve, recoverReserve, PROTOCOL, ReserveError} from './sdk/index.mjs';

// Read-only readiness before asking an undeployed contract for an account's
// payment. This does not authorize reserve setup: issuer and payment checks
// must still succeed in the caller after both RPCs see the expected runtime.
export async function inspectHostedDeployment({profile,clients}) {
  if(!Array.isArray(clients)||clients.length!==2)throw new Error('PUBLIC_RPC_NOT_APPROVED');
  const readings=await Promise.allSettled(clients.map(async client=>{
    const [chainId,code]=await Promise.all([client.getChainId(),client.getCode({address:profile.contractAddress,blockTag:'finalized'})]);
    return {chainId,code};
  }));
  if(readings.some(result=>result.status==='rejected'))return 'unavailable';
  const observations=readings.map(result=>result.value);
  if(observations.some(({chainId,code})=>chainId!==profile.chainId||(code&&code!=='0x'&&keccak256(code)!==profile.expectedRuntimeCodeHash)))return 'mismatch';
  const deployed=observations.filter(({code})=>code&&code!=='0x').length;
  return deployed===0?'awaiting-deployment':deployed===2?'ready':'partial';
}

// A deliberate continuation with an existing credential may find an immutable
// record. Confirm that record read-only; never replace it or retry an unclear write.
export async function prepareOrConfirmReserve(options, useExisting=false) {
  try { return await prepareReserve(options); }
  catch(error) {
    if(!useExisting || !['RESERVE_EXISTS','RESERVE_ALREADY_ATTEMPTED'].includes(error.code))throw error;
    const {expectedOwner,...config}=options.policy;
    const reopened=await recoverReserve({config,webAuthnClient:options.webAuthnClient,store:options.store,signal:options.signal,onProgress:stage=>{if(stage==='find-reserve')return options.onProgress?.('verify-reserve');}});
    try {
      if(reopened.owner!==expectedOwner)throw new ReserveError('OWNER_MISMATCH');
      const challenge=PROTOCOL+'/continuation:'+crypto.randomUUID();
      const signature=await reopened.account.signMessage({message:challenge});
      if(!await verifyMessage({address:expectedOwner,message:challenge,signature}))throw new ReserveError('INDEPENDENT_CHECK_FAILED');
      if(options.signal?.aborted)throw new ReserveError('OPERATION_CANCELLED');
      return Object.freeze({status:'ready',owner:expectedOwner,locator:reopened.locator,independentlyVerified:true,protocol:PROTOCOL});
    } finally { reopened.close(); }
  }
}
