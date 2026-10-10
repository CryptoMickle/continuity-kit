import { constants } from 'node:fs';
import {mkdir,open,lstat,realpath,unlink} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {randomBytes} from 'node:crypto';
import {SEQUENTIAL_OPERATOR_ROLES as ROLES,canonical} from './proposal.mjs';
const fail=code=>Object.assign(new Error(code),{code});
const owned=s=>typeof process.getuid!=='function'||s.uid===process.getuid();
const alias=p=>p.replace(/^\/private\/(tmp|var)(?=\/|$)/,'/$1');
/** Private append-only tickets; no raw transaction or key. A crash retains its
 * lock. Copying/deleting the journal defeats local at-most-once protection. */
export async function createSequentialOperatorJournal({directory,proposalHash,readOnly=false}){
 if(typeof directory!=='string'||!directory||directory.includes('\0')||directory.split('/').includes('..')||!/^[a-f0-9]{64}$/.test(proposalHash))throw fail('OPERATOR_JOURNAL_OPTIONS_INVALID');
 let root=resolve(directory);if(!readOnly){let parent=root;for(;;){try{await lstat(parent);break;}catch(e){if(e.code!=='ENOENT')throw e;parent=dirname(parent);}}const canonicalParent=await realpath(parent);if(alias(canonicalParent)!==alias(parent)||!(await lstat(canonicalParent)).isDirectory())throw fail('OPERATOR_JOURNAL_DIRECTORY_INVALID');await mkdir(root,{recursive:true,mode:0o700});}
 let rootStat;try{const requested=await lstat(root);if(requested.isSymbolicLink())throw fail('OPERATOR_JOURNAL_DIRECTORY_INVALID');const canonicalRoot=await realpath(root);if(alias(canonicalRoot)!==alias(root))throw fail('OPERATOR_JOURNAL_DIRECTORY_INVALID');root=canonicalRoot;rootStat=await lstat(root);if(!rootStat.isDirectory()||(rootStat.mode&0o7777)!==0o700||!owned(rootStat))throw fail('OPERATOR_JOURNAL_DIRECTORY_INVALID');}catch(e){if(!readOnly||e.code!=='ENOENT')throw e;}
 const sameRoot=async()=>{const s=await lstat(root);if(!rootStat||s.dev!==rootStat.dev||s.ino!==rootStat.ino||s.isSymbolicLink()||!s.isDirectory()||(s.mode&0o7777)!==0o700||!owned(s))throw fail('OPERATOR_JOURNAL_DIRECTORY_CHANGED');};
 const path=(role,phase)=>{if(!ROLES.includes(role))throw fail('OPERATOR_ROLE_NOT_APPROVED');return join(root,`${proposalHash}-${role}-${phase}.journal.json`);};
 const load=async file=>{let fd;try{if(!rootStat)return undefined;await sameRoot();fd=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);const s=await fd.stat();if(!s.isFile()||s.nlink!==1||(s.mode&0o7777)!==0o600||!owned(s)||s.size<1||s.size>4096)throw fail('OPERATOR_JOURNAL_FILE_INVALID');const b=Buffer.alloc(4097);const {bytesRead}=await fd.read(b,0,b.length,0),after=await fd.stat();if(bytesRead!==s.size||after.size!==s.size||after.mtimeMs!==s.mtimeMs||after.ctimeMs!==s.ctimeMs)throw fail('OPERATOR_JOURNAL_FILE_INVALID');const value=JSON.parse(b.subarray(0,bytesRead));return value;}catch(e){if(e.code==='ENOENT')return undefined;throw e;}finally{await fd?.close();}};
 async function read(role){const a=await load(path(role,'reserved')),b=await load(path(role,'signed'));if(b&&(!a||a.phase!=='reserved'||a.hash!==null||canonical({...b,phase:'reserved',hash:null})!==canonical(a)))throw fail('OPERATOR_JOURNAL_HISTORY_INVALID');return b??a;}
 const sync=async()=>{const fd=await open(root,'r');try{await fd.sync();}finally{await fd.close();}};
 let locked=false;
 async function write(entry){await sameRoot();const fd=await open(path(entry.role,entry.phase),'wx',0o600);try{await fd.writeFile(JSON.stringify(entry)+'\n');await fd.sync();}finally{await fd.close();}await sync();}
 return Object.freeze({durable:true,read,
  async reserve(entry){if(!locked||entry.proposalHash!==proposalHash||entry.phase!=='reserved'||entry.hash!==null||await read(entry.role))throw fail('OPERATOR_JOURNAL_RESERVATION_INVALID');await write(entry);},
  async pin(entry){const prior=await read(entry.role);if(!locked||!prior||prior.phase!=='reserved'||entry.phase!=='signed'||canonical({...entry,phase:'reserved',hash:null})!==canonical(prior))throw fail('OPERATOR_JOURNAL_PIN_INVALID');await write(entry);},
  async withLock(callback){if(readOnly||locked)throw fail('OPERATOR_JOURNAL_LOCKED');await sameRoot();const name=join(root,proposalHash+'.lock'),nonce=randomBytes(32).toString('hex');let fd;try{fd=await open(name,'wx',0o600);}catch(e){if(e.code==='EEXIST')throw fail('OPERATOR_JOURNAL_LOCKED');throw e;}const s=await fd.stat();locked=true;try{await fd.writeFile(JSON.stringify({nonce})+'\n');await fd.sync();await sync();return await callback();}finally{locked=false;await fd.close();await sameRoot();const current=await lstat(name);const marker=await load(name);if(current.dev!==s.dev||current.ino!==s.ino||current.isSymbolicLink()||canonical(marker)!==canonical({nonce}))throw fail('OPERATOR_JOURNAL_LOCK_CHANGED');await unlink(name);await sync();}},
 });
}
