// Compile-time public API consumer. This file never runs or creates credentials.
import { prepareReserve, recoverReserve } from '@continuitykit/account-reserve';
import { startReserveSetup, createReserveReceiver } from '@continuitykit/account-reserve/browser';
import { createReserveHttpStore } from '@continuitykit/account-reserve/http-store';
import { checkReserveEnvironment } from '@continuitykit/account-reserve/preflight';
const config = { appId: 'example', originalRpId: 'a.example.com', recoveryRpId: 'b.example.net', derivation: 'existing-account:v1' };
const store = createReserveHttpStore({ enrollmentToken: 'x'.repeat(43) });
export async function onlyATypeExample(key: Uint8Array) {
  const setup = startReserveSetup({ config, recoveryUrl: 'https://b.example.net/', privateKey: key, expectedOwner: '0x1111111111111111111111111111111111111111' });
  const ready = await setup.completion;
  const receiver = createReserveReceiver({ config, originalOrigin: 'https://a.example.com' });
  await receiver.prepare({ store, user: { name: 'Example', displayName: 'Example' } });
  receiver.dispose();
  const opened = await recoverReserve({ config, store });
  opened.close();
  return ready;
}
checkReserveEnvironment({ config, role: 'primary', originalOrigin: 'https://a.example.com', recoveryOrigin: 'https://b.example.net' });
// @ts-expect-error store is required
recoverReserve({ config });
// @ts-expect-error privateKey is bytes, never a hex string
prepareReserve({ privateKey: 'secret' });
