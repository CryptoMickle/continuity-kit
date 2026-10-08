const setupSteps = useExisting => [
  {id:'recovery-credential',label:useExisting?'Choose recovery passkey':'Create recovery passkey',detail:useExisting?'Choose your existing recovery passkey. Later approvals use this same key.':'Create one recovery passkey, separate from the original app passkey. Later approvals use this same recovery key.'},
  {id:'protect-reserve',label:'Protect reserve',detail:'Use the same recovery passkey to locate and protect the encrypted reserve. Keep the original window open.'},
  {id:'verify-reserve',label:'Verify independent opening',detail:'Open the stored reserve with the same recovery passkey and verify the original account. Setup is complete only after this check.'},
];
const recoverySteps = [
  {id:'find-reserve',label:'Find encrypted reserve',detail:'Choose the recovery passkey to find its stored reserve.'},
  {id:'unlock-reserve',label:'Open reserve',detail:'Approve the same recovery passkey again to unlock the account. This does not create another key or send a transaction.'},
  {id:'check-account',label:'Check existing payment',detail:'The reserve is open. Checking the original account and its existing payment on the chain.'},
];

// Stages advance only when their underlying operation does. They are not a
// timer, percentage estimate, or count of browser/OS approval prompts.
export function createReserveProgress({kind, useExisting=false, signal, onChange}) {
  if(!['setup','recovery'].includes(kind))throw new Error('PROGRESS_KIND_INVALID');
  const steps=kind==='setup'?setupSteps(useExisting):recoverySteps;
  let index=0,state='active';
  const snapshot=()=>Object.freeze({kind,state,index,total:steps.length,detail:steps[index].detail,steps:Object.freeze(steps.map((step,i)=>Object.freeze({...step,state:state==='complete'||i<index?'complete':i===index?state:'pending'})))});
  const emit=()=>{try{onChange?.(snapshot());}catch{/* Display failure cannot change reserve behavior. */}};
  const detach=()=>signal?.removeEventListener('abort',stop);
  function stop(){if(state!=='active')return false;state='stopped';detach();emit();return true;}
  function advance(id){
    if(signal?.aborted)stop();
    if(state!=='active')return false;
    const next=steps.findIndex(step=>step.id===id);
    if(next===index)return true;
    if(next!==index+1)return false;
    index=next;emit();return true;
  }
  function complete(){
    if(signal?.aborted)stop();
    if(state!=='active'||index!==steps.length-1)return false;
    state='complete';detach();emit();return true;
  }
  signal?.addEventListener('abort',stop,{once:true});
  if(signal?.aborted)stop();else emit();
  return Object.freeze({advance,complete,stop,snapshot});
}
