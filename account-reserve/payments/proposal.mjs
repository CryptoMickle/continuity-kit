import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAddress, getContractAddress, encodeFunctionData, keccak256 } from 'viem';
import { APPROVED_TESTNET_RPCS } from '../release/client-profile.mjs';

export const SEQUENTIAL_OPERATOR_ROLES = Object.freeze(['deploy','issue-first','issue-second']);
const MAX_FEE=200000000000n, PRIORITY=2000000000n, PAYMENT=10000000000000000n;
const fail=code=>{throw Object.assign(new Error(code),{code});};
export const canonical = value => JSON.stringify(value,(_,v)=>typeof v==='bigint'?v.toString():v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export function readSequentialArtifact() {
 const raw=readFileSync(new URL('./SequentialPayment.artifact.json',import.meta.url));
 const artifact=JSON.parse(raw);
 if(artifact.contractName!=='SequentialPayment'||artifact.compiler!=='solc 0.8.30; optimizer=200; EVM=paris; bytecode metadata omitted'||artifact.sourceSha256!==hash(readFileSync(new URL('./SequentialPayment.sol',import.meta.url)))||![artifact.bytecode,artifact.deployedBytecode].every(x=>typeof x==='string'&&/^0x(?:[0-9a-f]{2})+$/.test(x)))fail('OPERATOR_ARTIFACT_MISMATCH');
 return {artifact,artifactSha256:hash(raw),buildSha256:hash(readFileSync(new URL('./build.mjs',import.meta.url)))};
}
function address(v){try{if(typeof v!=='string')throw 0;const a=getAddress(v);if(/^0x0{40}$/i.test(a))throw 0;return a;}catch{fail('OPERATOR_ADDRESS_INVALID');}}
function nonce(v){if(typeof v!=='string'||!/^(0|[1-9][0-9]*)$/.test(v)||BigInt(v)>BigInt(Number.MAX_SAFE_INTEGER)-3n)fail('OPERATOR_NONCE_INVALID');return BigInt(v);}
export function sequentialRuntimeForIssuer(artifact,issuer) {
 const groups=Object.values(artifact.immutableReferences??{}),bytes=Buffer.from(artifact.deployedBytecode.slice(2),'hex'),word=Buffer.from(address(issuer).slice(2).toLowerCase().padStart(64,'0'),'hex'),used=new Set();
 if(groups.length!==1||!Array.isArray(groups[0])||!groups[0].length)fail('OPERATOR_IMMUTABLE_INVALID');
 for(const {start,length}of groups[0]){if(!Number.isSafeInteger(start)||start<0||length!==32||start+length>bytes.length)fail('OPERATOR_IMMUTABLE_INVALID');for(let i=start;i<start+length;i++){if(used.has(i)||bytes[i]!==0)fail('OPERATOR_IMMUTABLE_INVALID');used.add(i);}word.copy(bytes,start);}
 return '0x'+bytes.toString('hex');
}
/** Offline deterministic public proposal only. No signer or network access. */
export function buildSequentialPaymentProposal(input) {
 const names=['issuer','beneficiary','issuerNonce','beneficiaryNonce','expiresAt'];
 if(!input||typeof input!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(input))||Reflect.ownKeys(input).length!==names.length)fail('OPERATOR_PROPOSAL_INPUT_INVALID');
 const v={};for(const k of names){const d=Object.getOwnPropertyDescriptor(input,k);if(!d?.enumerable||!Object.hasOwn(d,'value'))fail('OPERATOR_PROPOSAL_INPUT_INVALID');v[k]=d.value;}
 const issuer=address(v.issuer),beneficiary=address(v.beneficiary),issuerNonce=nonce(v.issuerNonce),beneficiaryNonce=nonce(v.beneficiaryNonce);
 if(issuer===beneficiary)fail('OPERATOR_DISTINCT_ACTORS_REQUIRED');
 if(typeof v.expiresAt!=='string'||!Number.isFinite(Date.parse(v.expiresAt))||new Date(v.expiresAt).toISOString()!==v.expiresAt)fail('OPERATOR_EXPIRY_INVALID');
 const {artifact,artifactSha256,buildSha256}=readSequentialArtifact(),contractAddress=getContractAddress({from:issuer,nonce:issuerNonce});
 if(contractAddress.toLowerCase()===beneficiary.toLowerCase())fail('OPERATOR_DISTINCT_ACTORS_REQUIRED');
 const tx=(role,from,nonce,to,data,value,gas)=>({role,from,nonce:nonce.toString(),to,data,valueWei:value.toString(),gasLimitCeiling:gas.toString(),maxFeePerGasWei:MAX_FEE.toString(),maxPriorityFeePerGasWei:PRIORITY.toString(),maxFeeWei:(gas*MAX_FEE).toString(),type:'eip1559',chainId:10143});
 const issue=encodeFunctionData({abi:artifact.abi,functionName:'issue',args:[beneficiary]});
 const transactions=[tx('deploy',issuer,issuerNonce,null,artifact.bytecode,0n,1000000n),tx('issue-first',issuer,issuerNonce+1n,contractAddress,issue,PAYMENT,300000n),tx('claim-first',beneficiary,beneficiaryNonce,contractAddress,encodeFunctionData({abi:artifact.abi,functionName:'claim',args:[1n]}),0n,300000n),tx('issue-second',issuer,issuerNonce+2n,contractAddress,issue,PAYMENT,300000n),tx('claim-second',beneficiary,beneficiaryNonce+1n,contractAddress,encodeFunctionData({abi:artifact.abi,functionName:'claim',args:[2n]}),0n,300000n)];
 return {format:'continuitykit/sequential-payment-proposal/v1',network:{chainId:10143,rpcCandidates:[...APPROVED_TESTNET_RPCS]},issuer,beneficiary,proposedIssuerNonce:issuerNonce.toString(),proposedBeneficiaryNonce:beneficiaryNonce.toString(),expiresAt:v.expiresAt,contract:{address:contractAddress,artifactSha256,buildSha256,sourceSha256:artifact.sourceSha256,creationCodeHash:keccak256(artifact.bytecode),expectedRuntimeCodeHash:keccak256(sequentialRuntimeForIssuer(artifact,issuer)),compiler:artifact.compiler},transactions,budget:{maxTransactionCount:5,paymentPerRightWei:PAYMENT.toString(),totalEscrowWei:(2n*PAYMENT).toString(),issuerStartingCoverageWei:(1600000n*MAX_FEE+2n*PAYMENT).toString(),beneficiaryStartingCoverageWei:(600000n*MAX_FEE).toString(),maxTotalFeeWei:(2200000n*MAX_FEE).toString()},claims:[{rightId:'1',amount:PAYMENT.toString(),nonce:Number(beneficiaryNonce)},{rightId:'2',amount:PAYMENT.toString(),nonce:Number(beneficiaryNonce+1n)}]};
}
export function sequentialProposalHash(input){
 const rebuilt=buildSequentialPaymentProposal({issuer:input?.issuer,beneficiary:input?.beneficiary,issuerNonce:input?.proposedIssuerNonce,beneficiaryNonce:input?.proposedBeneficiaryNonce,expiresAt:input?.expiresAt});
 if(canonical(input)!==canonical(rebuilt))fail('OPERATOR_PROPOSAL_MISMATCH');return hash(canonical(rebuilt));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{if(process.argv.length!==6||process.argv[2]!=='--input'||process.argv[4]!=='--out')fail('OPERATOR_ARGUMENTS_INVALID');const bytes=readFileSync(process.argv[3]);if(bytes.length>4096)fail('OPERATOR_INPUT_TOO_LARGE');const proposal=buildSequentialPaymentProposal(JSON.parse(bytes.toString('utf8')));writeFileSync(process.argv[5],JSON.stringify(proposal,null,2)+'\n',{flag:'wx',mode:0o600});console.log(JSON.stringify({proposalHash:sequentialProposalHash(proposal),transactions:5,executed:false}));}catch{console.error('OPERATOR_PROPOSAL_FAILED');process.exitCode=1;}
}
