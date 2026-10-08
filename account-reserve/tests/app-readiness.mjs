import assert from 'node:assert/strict';
import {test} from 'node:test';
import {keccak256} from 'viem';
import {inspectHostedDeployment} from '../app-setup.mjs';

const runtime='0x60006000',address='0x1111111111111111111111111111111111111111';
const profile={chainId:10143,contractAddress:address,expectedRuntimeCodeHash:keccak256(runtime)};
function client(code,chainId=10143){return {
  async getChainId(){return chainId;},
  async getCode(request){assert.deepEqual(request,{address,blockTag:'finalized'});return code;},
  readContract(){assert.fail('readiness must not call an undeployed payment contract');},
};}

test('absent deployment keeps the account waiting without contract calls',async()=>{
  assert.equal(await inspectHostedDeployment({profile,clients:[client(undefined),client('0x')]}),'awaiting-deployment');
});

test('partial deployment or unavailable RPC never satisfies readiness',async()=>{
  assert.equal(await inspectHostedDeployment({profile,clients:[client(runtime),client(undefined)]}),'partial');
  assert.equal(await inspectHostedDeployment({profile,clients:[client(runtime),{async getChainId(){throw new Error('offline');},async getCode(){throw new Error('offline');}}]}),'unavailable');
});

test('both approved reads must see the expected chain and finalized runtime',async()=>{
  assert.equal(await inspectHostedDeployment({profile,clients:[client(runtime),client('0x60016000')]}),'mismatch');
  assert.equal(await inspectHostedDeployment({profile,clients:[client(runtime),client(runtime,143)]}),'mismatch');
  assert.equal(await inspectHostedDeployment({profile,clients:[client(runtime),client(runtime)]}),'ready');
  await assert.rejects(()=>inspectHostedDeployment({profile,clients:[client(runtime)]}),/PUBLIC_RPC_NOT_APPROVED/);
});
