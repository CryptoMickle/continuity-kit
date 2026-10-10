import {constants} from 'node:fs';
import {open} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {APPROVED_TESTNET_RPCS} from '../release/client-profile.mjs';
import {createPinnedOperatorClients,readProtectedOperatorSigner} from '../deploy/operator-runner.mjs';
import {createSequentialOperatorJournal} from './operator-journal.mjs';
import {createSequentialPaymentOperator,sequentialProposalHash,OPERATOR_ROLES,validateSequentialApproval} from './operator.mjs';
const fail=code=>Object.assign(new Error(code),{code});
export function parseSequentialOperatorArguments(argv){
 const args=[...argv],command=args[0]&&!args[0].startsWith('--')?args.shift():'inspect',result={command};
 if(!['inspect','preflight','reconcile','execute'].includes(command))throw fail('OPERATOR_COMMAND_INVALID');
 while(args.length){const flag=args.shift();if(flag==='--approve-exact-proposal'){if(result.confirmed)throw fail('OPERATOR_ARGUMENTS_INVALID');result.confirmed=true;continue;}
  const key={'--proposal':'proposalPath','--journal-dir':'journalDirectory','--role':'role','--approval':'approvalPath','--signer':'signerPath','--first-claim-hash':'firstClaimHash'}[flag];if(!key||result[key]!==undefined||!args[0]||args[0].startsWith('--'))throw fail('OPERATOR_ARGUMENTS_INVALID');result[key]=args.shift();}
 if(!result.proposalPath||!result.journalDirectory||(command==='inspect'?result.role!==undefined:!OPERATOR_ROLES.includes(result.role)))throw fail('OPERATOR_ARGUMENTS_INVALID');
 if(result.firstClaimHash!==undefined&&(!['execute','preflight'].includes(command)||result.role!=='issue-second'||!/^0x[0-9a-f]{64}$/i.test(result.firstClaimHash)))throw fail('OPERATOR_ARGUMENTS_INVALID');
 if(command==='execute'&&(!result.confirmed||!result.approvalPath||!result.signerPath))throw fail('OPERATOR_EXPLICIT_EXECUTE_FLAGS_REQUIRED');
 if(command!=='execute'&&(result.confirmed||result.approvalPath||result.signerPath))throw fail('OPERATOR_READONLY_SIGNER_FORBIDDEN');return result;
}
async function readPublicJson(path){let fd;try{fd=await open(resolve(path),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);const before=await fd.stat();if(!before.isFile()||before.size<1||before.size>100000)throw fail('OPERATOR_INPUT_INVALID');const bytes=Buffer.alloc(100001),{bytesRead}=await fd.read(bytes,0,bytes.length,0),after=await fd.stat();if(bytesRead!==before.size||after.size!==before.size||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs)throw fail('OPERATOR_INPUT_INVALID');return JSON.parse(bytes.subarray(0,bytesRead));}catch{throw fail('OPERATOR_INPUT_INVALID');}finally{await fd?.close();}}
export async function runSequentialOperator(argv,{readJson=readPublicJson,readSigner=readProtectedOperatorSigner,createClients=createPinnedOperatorClients,createJournal=createSequentialOperatorJournal,createOperator=createSequentialPaymentOperator}={}){
 const args=parseSequentialOperatorArguments(argv),proposal=await readJson(args.proposalPath),proposalHash=sequentialProposalHash(proposal);let approval;
 const validate=()=>validateSequentialApproval({approval,proposalHash,network:'public-testnet',rpcUrls:APPROVED_TESTNET_RPCS,expiresAt:proposal.expiresAt});
 if(args.command==='execute'){approval=await readJson(args.approvalPath);validate();}
 const journal=await createJournal({directory:args.journalDirectory,proposalHash,readOnly:args.command!=='execute'}),options={proposal,endpoints:createClients(),journal,network:'public-testnet'},readonly=createOperator(options);
 if(args.command==='inspect')return {proposalHash,network:'public-testnet',attempts:await readonly.inspect()};
 if(args.command==='reconcile')return readonly.reconcile(args.role);
 if(args.command==='preflight')return readonly.preflight(args.role,{firstClaimHash:args.firstClaimHash});
 if((await readonly.inspect()).find(r=>r.role===args.role)?.attempt)return readonly.reconcile(args.role);
 await readonly.preflight(args.role,{firstClaimHash:args.firstClaimHash});validate();
 const signer=await readSigner(args.signerPath);return createOperator({...options,signer}).execute({role:args.role,approval,firstClaimHash:args.firstClaimHash});
}
// Never emit RPC messages, nested causes, URLs, serialized transactions or keys.
// Unknown codes (including arbitrary uppercase secret-like text) stay generic.
const SAFE=new Set(['OPERATOR_ARGUMENTS_INVALID','OPERATOR_COMMAND_INVALID','OPERATOR_INPUT_INVALID','OPERATOR_EXPLICIT_EXECUTE_FLAGS_REQUIRED','OPERATOR_READONLY_SIGNER_FORBIDDEN','OPERATOR_EXACT_APPROVAL_REQUIRED','OPERATOR_APPROVAL_EXPIRED','OPERATOR_PROPOSAL_EXPIRED','OPERATOR_PROPOSAL_MISMATCH','OPERATOR_JOURNAL_LOCKED','OPERATOR_SIGNER_FILE_INVALID','OPERATOR_SIGNER_FILE_NOT_PROTECTED','OPERATOR_SIGNER_MISMATCH','OPERATOR_FIRST_CLAIM_NOT_FINALIZED','OPERATOR_CLAIM_HASH_REQUIRED','OPERATOR_PREVIOUS_STEP_NOT_FINALIZED','OPERATOR_NONCE_NOT_APPROVED','OPERATOR_GAS_NOT_APPROVED','OPERATOR_GAS_CHANGED','OPERATOR_FEE_CAP_EXCEEDED','OPERATOR_ISSUER_BALANCE_INSUFFICIENT','OPERATOR_BENEFICIARY_GAS_INSUFFICIENT','OPERATOR_RECEIPT_UNAVAILABLE','OPERATOR_RECEIPT_DISAGREEMENT','OPERATOR_RECEIPT_MISMATCH','OPERATOR_TRANSACTION_SCOPE_MISMATCH','OPERATOR_RUNTIME_MISMATCH','OPERATOR_CONTRACT_STATE_MISMATCH','OPERATOR_RPC_HEAD_DISAGREEMENT','OPERATOR_RPC_STATE_DISAGREEMENT','OPERATOR_STALE_OR_INVALID_HEAD']);
export function safeSequentialDiagnostic(error){const d=error&&typeof error==='object'?Object.getOwnPropertyDescriptor(error,'code'):null;return {error:d&&Object.hasOwn(d,'value')&&SAFE.has(d.value)?d.value:'OPERATOR_RUNNER_FAILED'};}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){try{console.log(JSON.stringify(await runSequentialOperator(process.argv.slice(2)),null,2));}catch(e){console.error(JSON.stringify(safeSequentialDiagnostic(e)));process.exitCode=1;}}
