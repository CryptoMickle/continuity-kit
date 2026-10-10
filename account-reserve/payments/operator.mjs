import {createHash} from 'node:crypto';
import {decodeEventLog,keccak256,parseTransaction,recoverTransactionAddress,serializeTransaction} from 'viem';
import {buildSequentialPaymentProposal,readSequentialArtifact,sequentialProposalHash,canonical,SEQUENTIAL_OPERATOR_ROLES as OPERATOR_ROLES} from './proposal.mjs';
export {sequentialProposalHash,OPERATOR_ROLES};
const fail=code=>Object.assign(new Error(code),{code});
const eq=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
const hexHash=v=>typeof v==='string'&&/^0x[0-9a-f]{64}$/i.test(v);
const emptyCode=v=>v===undefined||v==='0x';
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');
const copy=v=>JSON.parse(JSON.stringify(v));
export function validateSequentialApproval({approval,proposalHash,network,rpcUrls,now=Date.now,expiresAt}){
 if(!exact(approval,['format','proposalHash','network','rpcUrls','roles','expiresAt','approvedByUser'])||approval.format!=='continuitykit/sequential-operator-approval/v1'||approval.proposalHash!==proposalHash||approval.network!==network||approval.approvedByUser!==true||canonical(approval.rpcUrls)!==canonical(rpcUrls)||canonical(approval.roles)!==canonical(OPERATOR_ROLES))throw fail('OPERATOR_EXACT_APPROVAL_REQUIRED');
 const end=Date.parse(approval.expiresAt),time=now();if(!Number.isSafeInteger(time)||typeof approval.expiresAt!=='string'||!Number.isSafeInteger(end)||new Date(end).toISOString()!==approval.expiresAt||end<=time||end>time+86400000||end>Date.parse(expiresAt))throw fail('OPERATOR_APPROVAL_EXPIRED');
}
/** One explicitly approved issuer action. Public client dependencies are trusted;
 * only the separate runner binds the two fixed Monad RPCs. */
export function createSequentialPaymentOperator({proposal:input,endpoints,signer,journal,network='public-testnet',now=Date.now}){
 const proposalHash=sequentialProposalHash(input),proposal=copy(input),{artifact}=readSequentialArtifact();
 if(!Array.isArray(endpoints)||endpoints.length!==2||endpoints.some(e=>!e||typeof e.url!=='string'||!e.client))throw fail('OPERATOR_TWO_RPCS_REQUIRED');
 const rpcUrls=endpoints.map(e=>e.url),clients=endpoints.map(e=>e.client);
 if(network==='public-testnet'){if(canonical(rpcUrls)!==canonical(proposal.network.rpcCandidates))throw fail('OPERATOR_RPC_NOT_APPROVED');}
 else if(network!=='local-anvil'||rpcUrls.some(url=>!/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(url)||Number(new URL(url).port)>65535))throw fail('OPERATOR_NETWORK_INVALID');
 if(!journal||journal.durable!==true||['read','reserve','pin','withLock'].some(k=>typeof journal[k]!=='function'))throw fail('OPERATOR_DURABLE_JOURNAL_REQUIRED');
 if(signer&&(!eq(signer.address,proposal.issuer)||typeof signer.signTransaction!=='function'))throw fail('OPERATOR_SIGNER_MISMATCH');
 const txFor=role=>{if(!OPERATOR_ROLES.includes(role))throw fail('OPERATOR_ROLE_NOT_APPROVED');return proposal.transactions.find(t=>t.role===role);};
 const requestFor=(t,gas)=>({type:'eip1559',chainId:10143,...(t.to?{to:t.to}:{}),nonce:Number(t.nonce),data:t.data,value:BigInt(t.valueWei),gas,maxFeePerGas:BigInt(t.maxFeePerGasWei),maxPriorityFeePerGas:BigInt(t.maxPriorityFeePerGasWei),accessList:[]});
 const approve=approval=>validateSequentialApproval({approval,proposalHash,network,rpcUrls,now,expiresAt:proposal.expiresAt});
 const alive=()=>{if(Date.parse(proposal.expiresAt)<=now())throw fail('OPERATOR_PROPOSAL_EXPIRED');};
 function validateEnvelope(a,t,gas){if(a.type!=='eip1559'||a.chainId!==10143||(t.to?!eq(a.to,t.to):a.to!=null)||a.nonce!==Number(t.nonce)||(a.data??a.input??'0x')!==t.data||(a.value??0n)!==BigInt(t.valueWei)||typeof gas!=='bigint'||gas<=0n||gas>BigInt(t.gasLimitCeiling)||a.gas!==gas||a.maxFeePerGas!==BigInt(t.maxFeePerGasWei)||a.maxPriorityFeePerGas!==BigInt(t.maxPriorityFeePerGasWei)||(a.accessList?.length??0)!==0||a.authorizationList!==undefined||a.blobVersionedHashes!==undefined||a.maxFeePerBlobGas!==undefined)throw fail('OPERATOR_TRANSACTION_SCOPE_MISMATCH');}
 const validateEntry=(e,role)=>{if(!e)return undefined;if(!exact(e,['format','proposalHash','role','phase','gas','hash','firstClaimHash'])||e.format!=='continuitykit/sequential-operator-attempt/v1'||e.proposalHash!==proposalHash||e.role!==role||!['reserved','signed'].includes(e.phase)||typeof e.gas!=='string'||! /^[1-9][0-9]*$/.test(e.gas)||e.gas.length>12||BigInt(e.gas)>BigInt(txFor(role).gasLimitCeiling)||(e.phase==='reserved'?e.hash!==null:!hexHash(e.hash))||(role==='issue-second'?!hexHash(e.firstClaimHash):e.firstClaimHash!==null))throw fail('OPERATOR_JOURNAL_INVALID');return e;};
 const read=async role=>validateEntry(await journal.read(role),role);
 const persist=async entry=>{await journal[entry.phase==='reserved'?'reserve':'pin'](entry);if(canonical(await read(entry.role))!==canonical(entry))throw fail('OPERATOR_JOURNAL_READBACK_FAILED');};
  const blockValid = block => typeof block?.number === 'bigint' && block.number >= 0n && hexHash(block.hash) && typeof block.timestamp === 'bigint';
  const fresh = block => {
    const seconds = BigInt(Math.floor(now() / 1000));
    if (!blockValid(block) || block.timestamp > seconds + 15n || block.timestamp < seconds - 120n) throw fail('OPERATOR_STALE_OR_INVALID_HEAD');
  };
  async function heads() {
    const observed = await Promise.all(clients.map(async client => {
      const [chainId, latest, finalized] = await Promise.all([client.getChainId(), client.getBlock({ blockTag: 'latest' }), client.getBlock({ blockTag: 'finalized' })]);
      if (chainId !== 10143) throw fail('OPERATOR_CHAIN_MISMATCH');
      fresh(latest); fresh(finalized);
      if (latest.number < finalized.number || (latest.number === finalized.number && !eq(latest.hash, finalized.hash))) throw fail('OPERATOR_FINALIZED_HEAD_INVALID');
      const canonicalFinalized = await client.getBlock({ blockNumber: finalized.number });
      if (canonicalFinalized.number !== finalized.number || !eq(canonicalFinalized.hash, finalized.hash)) throw fail('OPERATOR_CANONICAL_BLOCK_MISMATCH');
      if (network === 'local-anvil') {
        const [version, accounts] = await Promise.all([client.request({ method: 'web3_clientVersion' }), client.request({ method: 'eth_accounts' })]);
        if (!/anvil/i.test(version) || !Array.isArray(accounts) || accounts.length) throw fail('OPERATOR_LOCAL_ANVIL_REQUIRED');
      }
      return { latest, finalized };
    }));
    // Providers can advance or lag normally. Agree on a numbered block at the
    // lower height, while retaining each live head for fee/freshness checks.
    const shared = {};
    for (const tag of ['latest', 'finalized']) {
      const height = observed[0][tag].number < observed[1][tag].number ? observed[0][tag].number : observed[1][tag].number;
      const blocks = await Promise.all(clients.map(client => client.getBlock({ blockNumber: height })));
      if (blocks.some(block => !blockValid(block) || block.number !== height) || !eq(blocks[0].hash, blocks[1].hash) || blocks[0].timestamp !== blocks[1].timestamp || blocks[0].baseFeePerGas !== blocks[1].baseFeePerGas) throw fail('OPERATOR_RPC_HEAD_DISAGREEMENT');
      fresh(blocks[0]); shared[tag] = blocks[0];
    }
    return { ...shared, liveHeads: observed.map(item => item.latest) };
  }
  async function assertCanonical(client, block) {
    const actual = await client.getBlock({ blockNumber: block.number });
    if (actual.number !== block.number || !eq(actual.hash, block.hash)) throw fail('OPERATOR_CANONICAL_BLOCK_MISMATCH');
  }
  async function actors(client, blockNumber) {
    const codes = await Promise.all([proposal.issuer, proposal.beneficiary].map(address => client.getCode({ address, blockNumber })));
    if (codes.some(code => !emptyCode(code))) throw fail('OPERATOR_ACTOR_CODE_UNEXPECTED');
  }

 async function contractState(client,blockNumber,phase){
  const address=proposal.contract.address,amount=BigInt(proposal.budget.paymentPerRightWei);
  const count=phase==='empty'?0:phase.startsWith('first')?1:2,claimed=phase.endsWith('claimed')&&!phase.endsWith('unclaimed');
  const [code,issuer,nextId,mapped,balance]=await Promise.all([client.getCode({address,blockNumber}),client.readContract({address,abi:artifact.abi,functionName:'issuer',blockNumber}),client.readContract({address,abi:artifact.abi,functionName:'nextId',blockNumber}),client.readContract({address,abi:artifact.abi,functionName:'rightForOwner',args:[proposal.beneficiary],blockNumber}),client.getBalance({address,blockNumber})]);
  if(!code||code==='0x'||keccak256(code)!==proposal.contract.expectedRuntimeCodeHash)throw fail('OPERATOR_RUNTIME_MISMATCH');
  if(!eq(issuer,proposal.issuer)||nextId!==BigInt(count+1)||mapped!==BigInt(count)||balance!==(count&&!claimed?amount:0n))throw fail('OPERATOR_CONTRACT_STATE_MISMATCH');
  for(let id=1;id<=count;id++){const r=await client.readContract({address,abi:artifact.abi,functionName:'getRight',args:[BigInt(id)],blockNumber});if(!eq(r.beneficiary,proposal.beneficiary)||r.amount!==amount||r.claimed!==(id<count||claimed))throw fail('OPERATOR_RIGHT_MISMATCH');}
 }
 async function preflight(role,firstClaimHash){
  alive();const tx=txFor(role),index=OPERATOR_ROLES.indexOf(role);
  if(index===2&&(await checkFirstClaim(firstClaimHash)).status!=='finalized')throw fail('OPERATOR_FIRST_CLAIM_NOT_FINALIZED');
  const observedHeads=await heads(),block=observedHeads.latest;
  const results=await Promise.all(clients.map(async c=>{
   await actors(c,block.number);
   const [issuerNonce,pendingIssuerNonce,ownerNonce,pendingOwnerNonce,issuerBalance,ownerBalance,priority,estimate]=await Promise.all([c.getTransactionCount({address:proposal.issuer,blockNumber:block.number}),c.getTransactionCount({address:proposal.issuer,blockTag:'pending'}),c.getTransactionCount({address:proposal.beneficiary,blockNumber:block.number}),c.getTransactionCount({address:proposal.beneficiary,blockTag:'pending'}),c.getBalance({address:proposal.issuer,blockNumber:block.number}),c.getBalance({address:proposal.beneficiary,blockNumber:block.number}),c.estimateMaxPriorityFeePerGas(),c.estimateGas({account:proposal.issuer,...requestFor(tx,BigInt(tx.gasLimitCeiling))})]);
   const expectedOwner=Number(proposal.proposedBeneficiaryNonce)+(index===2?1:0);
   if(issuerNonce!==Number(tx.nonce)||pendingIssuerNonce!==issuerNonce||ownerNonce!==expectedOwner||pendingOwnerNonce!==expectedOwner)throw fail('OPERATOR_NONCE_NOT_APPROVED');
   const remaining=proposal.transactions.filter(t=>OPERATOR_ROLES.slice(index).includes(t.role)).reduce((s,t)=>s+BigInt(t.maxFeeWei)+BigInt(t.valueWei),0n);
   if(issuerBalance<remaining)throw fail('OPERATOR_ISSUER_BALANCE_INSUFFICIENT');
   if(ownerBalance<BigInt(proposal.budget.beneficiaryStartingCoverageWei)/(index===2?2n:1n))throw fail('OPERATOR_BENEFICIARY_GAS_INSUFFICIENT');
   if(typeof priority!=='bigint'||priority<0n||priority>BigInt(tx.maxPriorityFeePerGasWei)||observedHeads.liveHeads.some(h=>typeof h.baseFeePerGas!=='bigint'||h.baseFeePerGas<0n||h.baseFeePerGas+BigInt(tx.maxPriorityFeePerGasWei)>BigInt(tx.maxFeePerGasWei)))throw fail('OPERATOR_FEE_CAP_EXCEEDED');
   if(typeof estimate!=='bigint'||estimate<=0n||estimate>BigInt(tx.gasLimitCeiling))throw fail('OPERATOR_GAS_NOT_APPROVED');
   if(!index){const [code,balance,nonce]=await Promise.all([c.getCode({address:proposal.contract.address,blockNumber:block.number}),c.getBalance({address:proposal.contract.address,blockNumber:block.number}),c.getTransactionCount({address:proposal.contract.address,blockNumber:block.number})]);if(!emptyCode(code)||balance!==0n||nonce!==0)throw fail('OPERATOR_CONTRACT_ALREADY_EXISTS');}
   else {await contractState(c,block.number,index===1?'empty':'first-claimed');await contractState(c,observedHeads.finalized.number,index===1?'empty':'first-claimed');}
   await assertCanonical(c,block);return {issuerBalance,ownerBalance,estimate};
  }));
  if(results[0].issuerBalance!==results[1].issuerBalance||results[0].ownerBalance!==results[1].ownerBalance)throw fail('OPERATOR_RPC_STATE_DISAGREEMENT');
  const gas=(results.reduce((m,r)=>r.estimate>m?r.estimate:m,0n)*120n+99n)/100n;
  if(gas>BigInt(tx.gasLimitCeiling))throw fail('OPERATOR_GAS_NOT_APPROVED');alive();return gas;
 }
  const receiptShape = receipt => ({ transactionHash: receipt.transactionHash?.toLowerCase(), from: receipt.from?.toLowerCase(), to: receipt.to?.toLowerCase() ?? null, contractAddress: receipt.contractAddress?.toLowerCase() ?? null, blockHash: receipt.blockHash?.toLowerCase(), blockNumber: receipt.blockNumber, transactionIndex: receipt.transactionIndex, status: receipt.status, type: receipt.type, gasUsed: receipt.gasUsed, effectiveGasPrice: receipt.effectiveGasPrice, logs: receipt.logs?.map(log => ({ address: log.address?.toLowerCase(), topics: log.topics?.map(topic => topic.toLowerCase()), data: log.data?.toLowerCase(), blockHash: log.blockHash?.toLowerCase(), blockNumber: log.blockNumber, transactionHash: log.transactionHash?.toLowerCase(), transactionIndex: log.transactionIndex, logIndex: log.logIndex, removed: log.removed })) });


 async function receiptFor(tx,hash,gas,phase){
  if(!hexHash(hash))throw fail('OPERATOR_CLAIM_HASH_REQUIRED');
  const head=await heads(),outcomes=await Promise.allSettled(clients.map(c=>c.getTransactionReceipt({hash})));
  const unavailable=outcomes.find(r=>r.status==='rejected'&&r.reason?.name!=='TransactionReceiptNotFoundError');if(unavailable)throw fail('OPERATOR_RECEIPT_UNAVAILABLE');
  if(outcomes.some(r=>r.status==='rejected'))return {role:tx.role,hash,status:'pending-or-unknown'};
  const receipts=outcomes.map(r=>r.value),receipt=receipts[0];
  if(canonical(receiptShape(receipt))!==canonical(receiptShape(receipts[1])))throw fail('OPERATOR_RECEIPT_DISAGREEMENT');
  const ceiling=gas??BigInt(tx.gasLimitCeiling);
  if(!eq(receipt.transactionHash,hash)||!eq(receipt.from,tx.from)||(tx.to?!eq(receipt.to,tx.to):receipt.to!=null)||typeof receipt.blockNumber!=='bigint'||receipt.blockNumber<0n||!hexHash(receipt.blockHash)||!Number.isSafeInteger(receipt.transactionIndex)||receipt.transactionIndex<0||receipt.type!=='eip1559'||!Array.isArray(receipt.logs)||typeof receipt.gasUsed!=='bigint'||receipt.gasUsed<=0n||receipt.gasUsed>ceiling||typeof receipt.effectiveGasPrice!=='bigint'||receipt.effectiveGasPrice<0n||receipt.effectiveGasPrice>BigInt(tx.maxFeePerGasWei))throw fail('OPERATOR_RECEIPT_MISMATCH');
  if(receipt.logs.some(l=>l.removed!==false||!eq(l.blockHash,receipt.blockHash)||l.blockNumber!==receipt.blockNumber||!eq(l.transactionHash,hash)||l.transactionIndex!==receipt.transactionIndex||!Number.isSafeInteger(l.logIndex)||l.logIndex<0))throw fail('OPERATOR_RECEIPT_MISMATCH');
  await Promise.all(clients.map(c=>assertCanonical(c,{number:receipt.blockNumber,hash:receipt.blockHash})));
  if(head.finalized.number<receipt.blockNumber)return {role:tx.role,hash,status:'awaiting-finality'};
  if(head.finalized.number===receipt.blockNumber&&!eq(head.finalized.hash,receipt.blockHash))throw fail('OPERATOR_CANONICAL_BLOCK_MISMATCH');
  await Promise.all(clients.map(async c=>{const t=await c.getTransaction({hash});validateEnvelope(t,tx,gas??t.gas);if(!eq(t.hash,hash)||!eq(t.from,tx.from)||!eq(t.blockHash,receipt.blockHash)||t.blockNumber!==receipt.blockNumber||t.transactionIndex!==receipt.transactionIndex)throw fail('OPERATOR_TRANSACTION_MISMATCH');const raw=serializeTransaction({...t,data:t.input??t.data},{r:t.r,s:t.s,yParity:t.yParity,v:t.v});if(keccak256(raw)!==hash||!eq(await recoverTransactionAddress({serializedTransaction:raw}),tx.from))throw fail('OPERATOR_SIGNED_OWNER_MISMATCH');}));
  if(receipt.status==='reverted')return {role:tx.role,hash,status:'reverted',action:'manual-reconciliation-required'};
  if(receipt.status!=='success'||(tx.role==='deploy'?!eq(receipt.contractAddress,proposal.contract.address):receipt.contractAddress!=null))throw fail('OPERATOR_RECEIPT_MISMATCH');
  if(tx.role==='deploy'){if(receipt.logs.length)throw fail('OPERATOR_UNEXPECTED_EVENT');}
  else {if(receipt.logs.length!==1||!eq(receipt.logs[0].address,proposal.contract.address))throw fail('OPERATOR_EVENT_MISMATCH');let event;try{event=decodeEventLog({abi:artifact.abi,topics:receipt.logs[0].topics,data:receipt.logs[0].data,strict:true});}catch{throw fail('OPERATOR_EVENT_MISMATCH');}if(event.eventName!==(tx.role.startsWith('claim')?'RightClaimed':'RightIssued')||event.args.id!==(tx.role==='issue-second'?2n:1n)||!eq(event.args.beneficiary,proposal.beneficiary)||event.args.amount!==BigInt(proposal.budget.paymentPerRightWei))throw fail('OPERATOR_EVENT_MISMATCH');}
  await Promise.all(clients.map(async c=>{await actors(c,receipt.blockNumber);await contractState(c,receipt.blockNumber,phase);const [issuerNonce,ownerNonce]=await Promise.all([c.getTransactionCount({address:proposal.issuer,blockNumber:receipt.blockNumber}),c.getTransactionCount({address:proposal.beneficiary,blockNumber:receipt.blockNumber})]);const expectedIssuer=tx.role==='claim-first'?Number(proposal.proposedIssuerNonce)+2:Number(tx.nonce)+1;const expectedOwner=Number(proposal.proposedBeneficiaryNonce)+(tx.role==='claim-first'||tx.role==='issue-second'?1:0);if(issuerNonce!==expectedIssuer||ownerNonce!==expectedOwner)throw fail('OPERATOR_FINALIZED_STATE_MISMATCH');await assertCanonical(c,{number:receipt.blockNumber,hash:receipt.blockHash});await assertCanonical(c,head.finalized);}));
  return {role:tx.role,hash,status:'finalized',blockNumber:receipt.blockNumber.toString(),blockHash:receipt.blockHash,network};
 }
 async function checkFirstClaim(hash){return receiptFor(proposal.transactions.find(t=>t.role==='claim-first'),hash,undefined,'first-claimed');}
 async function reconcile(role){const tx=txFor(role),entry=await read(role);if(!entry)return {role,status:'not-attempted'};if(entry.phase!=='signed')return {role,status:'blocked-unsigned-attempt',action:'manual-reconciliation-required'};return receiptFor(tx,entry.hash,BigInt(entry.gas),role==='deploy'?'empty':role==='issue-first'?'first-unclaimed':'second-unclaimed');}
 async function previous(role){for(const prior of OPERATOR_ROLES.slice(0,OPERATOR_ROLES.indexOf(role)))if((await reconcile(prior)).status!=='finalized')throw fail('OPERATOR_PREVIOUS_STEP_NOT_FINALIZED');}
 async function execute({role,approval,firstClaimHash}){
  txFor(role);const authorized=approval==null?approval:copy(approval),dependency=role==='issue-second'?firstClaimHash:null;if(role!=='issue-second'&&firstClaimHash!==undefined)throw fail('OPERATOR_CLAIM_HASH_UNEXPECTED');
  return journal.withLock(async()=>{
   if(await read(role))return reconcile(role);approve(authorized);if(!signer)throw fail('OPERATOR_SIGNER_REQUIRED');await previous(role);
   const tx=txFor(role),gas=await preflight(role,dependency);approve(authorized);
   const entry={format:'continuitykit/sequential-operator-attempt/v1',proposalHash,role,phase:'reserved',gas:gas.toString(),hash:null,firstClaimHash:dependency};await persist(entry);
   if(await preflight(role,dependency)>gas)throw fail('OPERATOR_GAS_CHANGED');approve(authorized);
   const serializedTransaction=await signer.signTransaction(requestFor(tx,gas));validateEnvelope(parseTransaction(serializedTransaction),tx,gas);
   if(!eq(await recoverTransactionAddress({serializedTransaction}),proposal.issuer))throw fail('OPERATOR_SIGNED_OWNER_MISMATCH');
   const hash=keccak256(serializedTransaction);await persist({...entry,phase:'signed',hash});
   if(await preflight(role,dependency)>gas)throw fail('OPERATOR_GAS_CHANGED');approve(authorized);
   const returned=await clients[0].sendRawTransaction({serializedTransaction});if(!eq(returned,hash))throw fail('OPERATOR_BROADCAST_HASH_MISMATCH');return reconcile(role);
  });
 }
 return Object.freeze({proposalHash,execute,reconcile,checkFirstClaim,async preflight(role,{firstClaimHash}={}){await previous(role);return {role,status:'preflight-ready',selectedGas:(await preflight(role,firstClaimHash)).toString()};},async inspect(){return Promise.all(OPERATOR_ROLES.map(async role=>({role,attempt:await read(role)??null})));}});
}
