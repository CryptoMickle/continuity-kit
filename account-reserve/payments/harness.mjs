import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  http,
  isAddress,
  keccak256,
  parseEventLogs,
  toHex,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const directory = dirname(fileURLToPath(import.meta.url));
const LOCAL_CHAIN_ID = 31337;
const DEFAULT_PAYMENT = 1_000_000_000_000_000n;
const SYNTHETIC_GAS_BALANCE = 1_000_000_000_000_000_000n;

export const LOCAL_CHAIN_SCOPE = 'Disposable loopback Anvil; sequential synthetic funded obligations; no public blockchain';

async function unusedLoopbackPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function address(value) {
  if (typeof value !== 'string' || !isAddress(value)) throw new Error('A valid local fixture beneficiary address is required');
  return getAddress(value);
}

function positiveId(value) {
  const id = BigInt(value);
  if (id < 1n) throw new Error('A positive local right identifier is required');
  return id;
}

/**
 * Starts one ephemeral local chain and deploys the owned payment fixture.
 * No public RPC, persistent account, remote fork, or fixed private key is used.
 * The employer key exists only inside this harness and is never returned.
 * rpc() is an INTERNAL primitive; an HTTP bridge must apply its own allowlist.
 */
export async function startSequentialPaymentChain(options = {}) {
  const artifact = JSON.parse(await readFile(join(directory, 'SequentialPayment.artifact.json'), 'utf8'));
  const source = await readFile(join(directory, 'SequentialPayment.sol'));
  if (createHash('sha256').update(source).digest('hex') !== artifact.sourceSha256) {
    throw new Error('SequentialPayment artifact does not match source; rebuild the local fixture');
  }
  const port = await unusedLoopbackPort();
  const rpcUrl = `http://127.0.0.1:${port}`;
  const binary = options.anvilPath ?? process.env.CONTINUITY_ANVIL ?? join(homedir(), '.foundry/bin/anvil');
  const child = spawn(binary, [
    '--accounts', '0', '--silent', '--host', '127.0.0.1',
    '--port', String(port), '--chain-id', String(LOCAL_CHAIN_ID),
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  // Do not relay child output to logs. There are no generated default accounts.
  child.stderr.resume();
  let spawnError;
  child.on('error', (error) => { spawnError = error; });
  let childExited = false;
  const exit = new Promise((resolve) => { const ended = () => { childExited = true; resolve(); }; child.once('exit', ended); child.once('close', ended); });
  let closed = false, closing;
  let requestId = 0;
  let publicClient;
  let employerWallet;

  function close() {
    if (closing) return closing;
    closed = true; publicClient = undefined; employerWallet = undefined;
    closing = (async () => {
      if (childExited) return;
      child.kill('SIGTERM');
      const force = setTimeout(() => child.kill('SIGKILL'), 2000);
      force.unref();
      await exit; clearTimeout(force);
    })();
    return closing;
  }

  async function rpc(method, params = []) {
    if (closed) throw new Error('Local fixture chain is closed');
    if (spawnError) throw new Error('Could not start the local Anvil binary', { cause: spawnError });
    if (childExited) throw new Error('Local Anvil process exited');
    const result = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method, params }),
      signal: AbortSignal.timeout(5000),
    });
    if (!result.ok) throw new Error(`Local RPC HTTP ${result.status}`);
    const body = await result.json();
    if (body.error) {
      const error = new Error(body.error.message ?? 'Local RPC request failed');
      error.code = body.error.code;
      error.data = body.error.data;
      throw error;
    }
    return body.result;
  }

  try {
    const deadline = Date.now() + 10_000;
    for (;;) {
      if (spawnError) throw new Error('Could not start the local Anvil binary', { cause: spawnError });
      if (childExited) throw new Error('Local Anvil exited before startup');
      try {
        const [chainId, version] = await Promise.all([rpc('eth_chainId'), rpc('web3_clientVersion')]);
        if (Number(BigInt(chainId)) !== LOCAL_CHAIN_ID || !/anvil/i.test(version)) {
          throw new Error('Unexpected server on disposable local chain port');
        }
        break;
      } catch (error) {
        if (Date.now() >= deadline || /Unexpected server/.test(error.message)) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }

    const chain = defineChain({
      id: LOCAL_CHAIN_ID,
      name: 'Continuity sequential payment fixture',
      nativeCurrency: { name: 'Synthetic local test units', symbol: 'TEST', decimals: 18 },
      rpcUrls: { default: { http: [rpcUrl] } },
    });
    const transport = () => http(rpcUrl, { retryCount: 0, timeout: 5000 });
    publicClient = createPublicClient({ chain, transport: transport() });
    const employer = privateKeyToAccount(generatePrivateKey());
    employerWallet = createWalletClient({ account: employer, chain, transport: transport() });
    await rpc('anvil_setBalance', [employer.address, toHex(1_000n * SYNTHETIC_GAS_BALANCE)]);
    const deploymentHash = await employerWallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode });
    const deployed = await publicClient.waitForTransactionReceipt({ hash: deploymentHash, timeout: 5000 });
    if (deployed.status !== 'success' || !deployed.contractAddress) throw new Error('Local fixture deployment failed');
    const contractAddress = getAddress(deployed.contractAddress);
    const abi = artifact.abi;
    const runtimeCode = await publicClient.getCode({ address: contractAddress });
    if (!runtimeCode || runtimeCode === '0x') throw new Error('Local fixture runtime is absent');
    const runtimeCodeHash = keccak256(runtimeCode);
    if (getAddress(await publicClient.readContract({ address: contractAddress, abi, functionName: 'issuer' })) !== employer.address) throw new Error('Local fixture issuer mismatch');

    async function readRight(rightId) {
      if (closed) throw new Error('Local fixture chain is closed');
      const id = positiveId(rightId);
      const right = await publicClient.readContract({ address: contractAddress, abi, functionName: 'getRight', args: [id] });
      return { id, beneficiary: getAddress(right.beneficiary), amount: right.amount, claimed: right.claimed };
    }

    async function rightForOwner(owner) {
      if (closed) throw new Error('Local fixture chain is closed');
      const id = await publicClient.readContract({ address: contractAddress, abi, functionName: 'rightForOwner', args: [address(owner)] });
      return id === 0n ? null : readRight(id);
    }

    let writeTail = Promise.resolve();
    const seeded = new Set();
    async function preparePayment(owner, { amount = DEFAULT_PAYMENT } = {}) {
      const beneficiary = address(owner), value = BigInt(amount);
      if (value <= 0n || value > SYNTHETIC_GAS_BALANCE) throw new Error('Local synthetic payment must be positive and at most one test unit');
      const prepare = async () => {
        const existing = await rightForOwner(beneficiary);
        if (existing && !existing.claimed) throw Object.assign(new Error('OUTSTANDING_PAYMENT'), { code: 'OUTSTANDING_PAYMENT' });
        // Explicit local scaffolding only. Seed once; subsequent payments never
        // reset the beneficiary balance or erase previous receipts/gas spending.
        if (!seeded.has(beneficiary)) {
          const balance = await publicClient.getBalance({ address: beneficiary });
          if (balance < SYNTHETIC_GAS_BALANCE) await rpc('anvil_setBalance', [beneficiary, toHex(SYNTHETIC_GAS_BALANCE)]);
          seeded.add(beneficiary);
        }
        const transactionHash = await employerWallet.writeContract({ address: contractAddress, abi, functionName: 'issue', args: [beneficiary], value });
        const receipt = await publicClient.waitForTransactionReceipt({ hash: transactionHash, timeout: 5000 });
        if (receipt.status !== 'success') throw new Error('Local payment issuance reverted');
        const events = parseEventLogs({ abi, eventName: 'RightIssued', logs: receipt.logs, strict: true })
          .filter(log => getAddress(log.address) === contractAddress && getAddress(log.args.beneficiary) === beneficiary);
        if (events.length !== 1 || events[0].args.amount !== value || existing && events[0].args.id <= existing.id) throw new Error('Local payment issuance event mismatch');
        return Object.freeze({ ...(await readRight(events[0].args.id)), transactionHash });
      };
      const result = writeTail.then(prepare); writeTail = result.catch(() => {}); return result;
    }

    async function claimReceipt(transactionHash) {
      if (closed) throw new Error('Local fixture chain is closed');
      if (!/^0x[0-9a-fA-F]{64}$/.test(transactionHash)) throw new Error('Invalid local transaction hash');
      const receipt = await publicClient.waitForTransactionReceipt({ hash: transactionHash, timeout: 5000 });
      const events = parseEventLogs({ abi, eventName: 'RightClaimed', logs: receipt.logs, strict: true })
        .filter((log) => getAddress(log.address) === contractAddress);
      return { status: receipt.status, transactionHash, blockNumber: receipt.blockNumber, claims: events.map((log) => ({ id: log.args.id, beneficiary: log.args.beneficiary, amount: log.args.amount })) };
    }

    return Object.freeze({
      chainId: LOCAL_CHAIN_ID, rpcUrl, contractAddress, abi,
      scope: LOCAL_CHAIN_SCOPE,
      issuer: employer.address, deploymentHash, runtimeCodeHash,
      preparePayment, readRight, rightForOwner, claimReceipt, rpc, close,
    });
  } catch (error) {
    await close();
    throw error;
  }
}
