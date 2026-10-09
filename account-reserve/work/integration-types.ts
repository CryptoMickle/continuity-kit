import { validateWork, recoverWorkReserve, WORK_SCHEMA, type ContinuityWork, type WorkReserveReady } from '@continuitykit/account-reserve/work-reserve';
import { startWorkReserveSetup, createWorkReserveReceiver } from '@continuitykit/account-reserve/work-browser';
import { createReserveHttpStore } from '@continuitykit/account-reserve/http-store';
const config = { appId: 'work-typecheck', originalRpId: 'app.example.com', recoveryRpId: 'reserve.example.net', derivation: 'leaf:v1' };
const work: ContinuityWork = validateWork({ schema: WORK_SCHEMA, title: 'Title', client: 'Client', brief: 'Brief', deliverable: 'Draft', nextStep: 'Next' });
async function example(privateKey: Uint8Array, expectedOwner: `0x${string}`) {
  const controller = startWorkReserveSetup({ config, work, privateKey, expectedOwner, recoveryUrl: 'https://reserve.example.net/' });
  const prepared: WorkReserveReady = await controller.completion;
  const receiver = createWorkReserveReceiver({ config, originalOrigin: 'https://app.example.com' });
  receiver.dispose();
  const opened = await recoverWorkReserve({ config, store: createReserveHttpStore() });
  const value: string = opened.work.deliverable;
  // @ts-expect-error Work-only recovery exposes no signing account.
  opened.account;
  const signer = await opened.openAccount();
  await signer.account.signMessage({ message: 'Local proof only' });
  signer.close(); opened.close();
  return { value, digest: prepared.workDigest };
}
void example; void work;
