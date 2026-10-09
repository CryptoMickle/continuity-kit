import {createPlayground,example} from './model.mjs';
const $=id=>document.getElementById(id);
const fields=['title','client','brief','deliverable','nextStep'];
let session,busy=false;
const work=()=>({schema:example.schema,...Object.fromEntries(fields.map(f=>[f,$(f).value]))});
const fill=value=>fields.forEach(f=>$(f).value=value[f]);
function render(){
  const state=session.report(),phase=state.phase;
  $('report').textContent=JSON.stringify(state,null,2);
  $('snapshot-state').textContent=phase==='draft'?'Not yet':'Encrypted & checked';
  $('work-form').hidden=phase==='offline';$('offline-panel').hidden=phase!=='offline';
  fields.forEach(f=>$(f).disabled=busy||phase==='prepared'||phase==='offline');
  $('editor-label').textContent=phase==='recovered'?'Recovered workspace':'Original workspace';
  $('editor-badge').textContent=phase==='recovered'?'B · Ready to continue':phase==='offline'?'A · Unavailable':'A · Available';
  $('exports').hidden=phase!=='recovered';$('next').hidden=phase==='recovered';$('damage').hidden=phase==='draft';
  for(const id of ['next','reset','damage','export-txt','export-json'])$(id).disabled=busy;
  const content={draft:['START WITH SOMETHING WORTH KEEPING','Make it yours.','Add a phrase to the draft. Then prepare an encrypted snapshot with the real ContinuityKit SDK.','Prepare this snapshot'],prepared:['THE RESERVE HAS BEEN CHECKED','Now let the app go.','The stored snapshot has been independently reopened and checked by the SDK. Next, discard the original in-memory workspace.','Take original app offline'],offline:['THE ORIGINAL IS UNAVAILABLE','Open a way back.','A new SDK recovery context will find the encrypted snapshot with the surviving simulated credential. No file or address to paste.','Open the reserve'],recovered:['WORK RECOVERED · SIGNING LOCKED','Pick up the thought.','Your prepared draft is back. Finish the confirmation message in the recovered draft and export it. These edits do not change the saved snapshot.','']};
  const [label,title,copy,button]=content[phase];$('action-label').textContent=label;$('action-title').textContent=title;$('action-copy').textContent=copy;$('next').textContent=busy?'Working…':button;
  $('editor-foot').textContent=phase==='recovered'?'Edits affect this local copy. Export to keep them.':phase==='prepared'?'This snapshot is fixed. Future edits are not automatically protected.':phase==='offline'?'The reserve survives only inside this demonstration tab.':'Change a line before preparing. You’ll recognize it when it comes back.';
  const index=phase==='draft'?1:phase==='prepared'?2:3;
  for(let n=1;n<=3;n++){const step=$('step-'+n);step.removeAttribute('aria-current');step.classList.toggle('done',n<index);if(n===index)step.setAttribute('aria-current','step');}
}
async function run(action){if(busy)return;busy=true;$('status').textContent='';$('status').className='';render();try{await action();}catch(error){$('status').className='error';$('status').textContent=error.code==='WORK_TOO_LARGE'?'This example holds a small draft. Shorten it and try again.':'The action did not complete. Your current page is still here. Start again to reset this fictional example.';console.error('Playground action:',error.code||error.message);}finally{busy=false;render();}}
$('next').addEventListener('click',()=>run(async()=>{const phase=session.report().phase;if(phase==='draft'){await session.prepare(work());$('status').textContent='Snapshot encrypted, read back and independently checked.';}else if(phase==='prepared'){session.takeOffline();fill({title:'',client:'',brief:'',deliverable:'',nextStep:''});}else if(phase==='offline'){fill(await session.recover());$('status').textContent='The prepared content passed verification. Account signing stays locked.';}}));
$('damage').addEventListener('click',()=>run(async()=>{$('damage-result').textContent='';await session.rejectDamagedCopy();$('damage-result').textContent='Damaged copy rejected. The intact snapshot is unchanged.';}));
function download(format){try{const text=session.exportWork(work(),format);const blob=new Blob([text],{type:format==='json'?'application/json':'text/plain;charset=utf-8'});const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download='continuity-playground-copy.'+format;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);$('status').textContent='Local export created. The encrypted snapshot is unchanged.';}catch{$('status').className='error';$('status').textContent='Export could not finish. Keep this page open and shorten the draft if needed.';}}
$('export-txt').addEventListener('click',()=>download('txt'));$('export-json').addEventListener('click',()=>download('json'));
$('work-form').addEventListener('submit',event=>event.preventDefault());
async function reset(){if(busy)return;busy=true;$('reset').disabled=true;$('next').disabled=true;session?.dispose();try{session=await createPlayground();fill(example);$('status').textContent='';$('damage-result').textContent='';}catch{$('status').textContent='This browser could not initialize the example. Try a current browser on HTTPS.';}finally{busy=false;if(session)render();}}
$('reset').addEventListener('click',reset);window.addEventListener('pagehide',()=>session?.dispose());window.addEventListener('pageshow',event=>{if(event.persisted){busy=false;session=undefined;reset();}});reset();
