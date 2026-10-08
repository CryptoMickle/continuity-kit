import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {resolve, extname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseTransaction, decodeFunctionData} from 'viem';
import {startLocalChain} from './chain/harness.mjs';

const root=fileURLToPath(new URL('./dist/',import.meta.url));
function localPort(value,fallback){const n=value===undefined?fallback:Number(value);if(!Number.isInteger(n)||n<1024||n>65535)throw new Error('LOCAL_PORT_INVALID');return n;}
const primaryPort=localPort(process.env.CONTINUITY_PRIMARY_PORT,4573);
const recoveryPort=localPort(process.env.CONTINUITY_RECOVERY_PORT,4574);
if(primaryPort===recoveryPort)throw new Error('LOCAL_PORT_COLLISION');
const primaryOrigin=`http://continuity-primary.localhost:${primaryPort}`;
const recoveryOrigin=`http://continuity-reserve.localhost:${recoveryPort}`;
const chain=await startLocalChain();
const store=new Map(), credentials=new Map();
let primaryOnline=true, issued=0;
const physicalEnabled=process.argv.includes('--physical-approved');
const metrics={syntheticCreates:0,syntheticAssertions:0,storeReads:0,storeWrites:0,rpcReads:0,rpcWrites:0};
const servers=[];
const reply=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value,(_,v)=>typeof v==='bigint'?v.toString():v));};
function fail(message){throw new Error(message);}
async function body(req){let s=''; for await(const part of req){s+=part; if(s.length>100000)fail('REQUEST_TOO_LARGE');} return JSON.parse(s||'{}');}
const b64=b=>Buffer.from(b).toString('base64url');
function synthetic(input,role){
  if(physicalEnabled)fail('SYNTHETIC_DISABLED');
  const rp=role==='primary'?'continuity-primary.localhost':'continuity-reserve.localhost';
  if(input.rpId!==rp||!['iris','accrue'].includes(input.model)||typeof input.salt!=='string'||!/^[a-f0-9]{64}$/.test(input.salt))fail('SYNTHETIC_REQUEST_INVALID');
  let id=input.credentialId;
  if(input.action==='create'){
    if(credentials.size>=16)fail('SYNTHETIC_LIMIT');
    id=b64(randomBytes(24)); credentials.set(id,{rp,model:input.model,outputs:new Map()}); metrics.syntheticCreates++;
  }else if(input.action==='get'){
    if(!id)id=[...credentials].reverse().find(([,r])=>r.rp===rp&&r.model===input.model)?.[0];
    metrics.syntheticAssertions++;
  }else fail('SYNTHETIC_REQUEST_INVALID');
  const record=credentials.get(id);
  if(!record||record.rp!==rp||record.model!==input.model)fail('SYNTHETIC_CREDENTIAL_MISSING');
  if(!record.outputs.has(input.salt))record.outputs.set(input.salt,randomBytes(32));
  return {credentialId:id,prfOutput:b64(record.outputs.get(input.salt)),synthetic:true};
}
const readMethods=new Set(['eth_chainId','eth_blockNumber','eth_getBalance','eth_getTransactionCount','eth_gasPrice','eth_maxPriorityFeePerGas','eth_feeHistory','eth_getBlockByNumber','eth_getTransactionReceipt','eth_getTransactionByHash','eth_getCode','eth_call','eth_estimateGas']);
async function boundedRpc(input){
  const {method,params=[]}=input;
  if(!Array.isArray(params))fail('RPC_INVALID');
  if(method==='eth_sendRawTransaction'){
    const tx=parseTransaction(params[0]);
    if(tx.chainId!==31337||tx.to?.toLowerCase()!==chain.contractAddress.toLowerCase()||(tx.value??0n)!==0n)fail('TRANSACTION_OUTSIDE_DEMO');
    const call=decodeFunctionData({abi:chain.abi,data:tx.data});
    if(call.functionName!=='claim'||tx.data.length!==74)fail('TRANSACTION_OUTSIDE_DEMO');
    if((tx.gas??0n)>300000n||(tx.maxFeePerGas??tx.gasPrice??0n)>100000000000n)fail('TRANSACTION_FEE_LIMIT');
    metrics.rpcWrites++;
  }else{
    if(!readMethods.has(method))fail('RPC_METHOD_BLOCKED');
    if(['eth_call','eth_estimateGas'].includes(method)&&params[0]?.to?.toLowerCase()!==chain.contractAddress.toLowerCase())fail('RPC_TARGET_BLOCKED');
    metrics.rpcReads++;
  }
  return chain.rpc(method,params);
}
function serve(role,port,origin){
  const server=createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store'); res.setHeader('X-Content-Type-Options','nosniff'); res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    if(req.headers.host!==new URL(origin).host){reply(res,421,{error:'HOST_REJECTED'});return;}
    const url=new URL(req.url,origin);
    try{
      if(role==='primary'&&!primaryOnline){reply(res,503,{error:'PRIMARY_OFFLINE'});return;}
      if(req.method!=='GET'&&(req.headers.origin!==origin||req.headers['content-type']!=='application/json')){reply(res,403,{error:'ORIGIN_REJECTED'});return;}
      if(url.pathname==='/api/config'&&req.method==='GET'){reply(res,200,{role,primaryOrigin,recoveryOrigin,physicalEnabled,chainId:31337,contractAddress:chain.contractAddress,abi:chain.abi});return;}
      if(url.pathname==='/api/status'&&req.method==='GET'){reply(res,200,{primaryOnline,mode:physicalEnabled?'physical local test':'synthetic local test',ciphertextRecords:store.size,metrics});return;}
      if(url.pathname==='/control/primary'&&role==='recovery'&&req.method==='POST'){
        const input=await body(req); if(typeof input.online!=='boolean')fail('CONTROL_INVALID'); primaryOnline=input.online;reply(res,200,{primaryOnline});return;
      }
      if(url.pathname==='/api/synthetic/credential'&&req.method==='POST'){reply(res,200,synthetic(await body(req),role));return;}
      if(url.pathname==='/api/prepare-right'&&role==='primary'&&req.method==='POST'){
        const input=await body(req);if(!/^0x[0-9a-fA-F]{40}$/.test(input.owner)||issued>=8)fail('RIGHT_REQUEST_INVALID');
        const right=await chain.prepareRight(input.owner);issued++;reply(res,200,right);return;
      }
      if(url.pathname.startsWith('/api/store/')&&role==='recovery'){
        const key=url.pathname.slice('/api/store/'.length);if(!/^[A-Za-z0-9_-]{20,160}$/.test(key))fail('LOCATOR_INVALID');
        if(req.method==='GET'){metrics.storeReads++; const value=store.get(key);reply(res,value?200:404,value?{bytes:b64(value)}:{error:'RESERVE_MISSING'});return;}
        if(req.method==='PUT'){
          const input=await body(req);if(typeof input.bytes!=='string'||input.bytes.length>90000)fail('RECORD_INVALID');
          const bytes=Buffer.from(input.bytes,'base64url');if(!bytes.length||bytes.length>65536||b64(bytes)!==input.bytes)fail('RECORD_INVALID');
          if(store.has(key)){reply(res,409,{error:'RESERVE_EXISTS'});return;}if(store.size>=16)fail('STORE_LIMIT');
          store.set(key,bytes);metrics.storeWrites++;reply(res,201,{created:true});return;
        }
      }
      if(url.pathname==='/rpc'&&req.method==='POST'){
        const input=await body(req);try{reply(res,200,{jsonrpc:'2.0',id:input.id,result:await boundedRpc(input)});}catch(e){reply(res,200,{jsonrpc:'2.0',id:input.id,error:{code:-32000,message:e.shortMessage||e.message,data:e.data}});}return;
      }
      if(req.method!=='GET'){reply(res,405,{error:'METHOD_BLOCKED'});return;}
      const file=resolve(root,'.'+(url.pathname==='/'?'/index.html':url.pathname));
      if(!file.startsWith(root)||url.pathname.includes('..'))fail('PATH_INVALID');
      const bytes=await readFile(file);res.writeHead(200,{'Content-Type':({'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css'})[extname(file)]||'application/octet-stream'});res.end(bytes);
    }catch(error){reply(res,400,{error:error.code==='ENOENT'?'NOT_FOUND':error.message});}
  });
  servers.push(server);
  return new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
}
try{await serve('primary',primaryPort,primaryOrigin);await serve('recovery',recoveryPort,recoveryOrigin);}catch(error){for(const s of servers)s.close();await chain.close();throw error;}
console.log(JSON.stringify({primaryOrigin,recoveryOrigin,mode:physicalEnabled?'PHYSICAL APPROVED LOCAL ONLY':'SYNTHETIC LOCAL ONLY',chainId:31337}));
async function close(){for(const s of servers)s.close();for(const r of credentials.values())for(const b of r.outputs.values())b.fill(0);credentials.clear();store.clear();await chain.close();process.exit();}
process.once('SIGINT',close);process.once('SIGTERM',close);
