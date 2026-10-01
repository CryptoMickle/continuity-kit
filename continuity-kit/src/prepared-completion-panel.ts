import { createRuntime } from "./runtime.ts";
import { MeraPasskeyAdapter } from "./sdk/passkeys.ts";
import { openPreparedCompletion } from "../testnet/complete-prepared.ts";
import type { WriteOutcome } from "./sdk/types.ts";

declare const __CONTINUITY_TESTNET_CONFIG__: unknown;
const pin = Object.freeze({
  owner: "0x5ff3d5ff4794a7abdf7a888aa58b72a6aaff633c",
  streamId:
    "0x28d885f12264b15ddede7c98d34d9fe728cb874b1bf49e447a29197a9cfc454a",
  manifestDigest:
    "0x00552e9aa966a23265e24dcd45321937e9235e472cfba53bdfc26c91c52bb564",
  capsuleDigest:
    "0x86e4e033815d3038d400262a920d8cfbd0b58e0ff59ead160030d9271ff9e83e",
} as const);
const openButton = document.querySelector<HTMLButtonElement>("#open")!;
const completeButton = document.querySelector<HTMLButtonElement>("#complete")!;
const checkButton = document.querySelector<HTMLButtonElement>("#reconcile")!;
const status = document.querySelector<HTMLElement>("#status")!;
const proof = document.querySelector<HTMLElement>("#proof")!;
const preview = document.querySelector<HTMLElement>("#preview")!;
document.querySelector("#pin")!.textContent = JSON.stringify(pin, null, 2);
let repair: Awaited<ReturnType<typeof openPreparedCompletion>> | undefined;
let attempted = false;
let busy = false;
const lifetime = new AbortController();
function errorNotice(error: unknown) {
  const code =
    error && typeof error === "object" && "code" in error
      ? String(error.code)
      : "ACTION_FAILED";
  status.textContent =
    code === "CREDENTIAL_MISMATCH"
      ? "Denne nøkkelen tilhører en annen testkonto. Velg dagens nyeste primærnøkkel. Ingen transaksjon er sendt."
      : `Kontrollen stoppet (${code}). La siden stå åpen og meld fra i chatten. Ingen fullføring blir hevdet.`;
}
function show(outcome: WriteOutcome) {
  proof.textContent = JSON.stringify(outcome, null, 2);
  status.textContent =
    outcome.status === "confirmed"
      ? "Første versjon er registrert og kontrollert på testnet. Reservegjenoppretting med eksisterende B-nøkkel må fortsatt prøves. Meld «klar» i chatten."
      : "Transaksjonsstatus er uklar. Ikke send igjen. Bruk Kontroller sendt transaksjon og meld fra i chatten.";
}
function controls() {
  openButton.disabled =
    busy || attempted || !!repair || lifetime.signal.aborted;
  completeButton.disabled =
    busy || attempted || !repair || lifetime.signal.aborted;
  checkButton.disabled = busy || !repair?.ticket || lifetime.signal.aborted;
}
try {
  const runtime = createRuntime(
    typeof __CONTINUITY_TESTNET_CONFIG__ === "undefined"
      ? undefined
      : __CONTINUITY_TESTNET_CONFIG__,
  );
  if (
    runtime.kind !== "monad-testnet" ||
    runtime.policy.trustMode !== "trusted-rpc-quorum" ||
    runtime.adapters.trustMode !== "trusted-rpc-quorum" ||
    location.origin !== runtime.policy.aOrigin ||
    runtime.policy.registryAddress !==
      "0x3fc9997e62e56ba17225a47c32ad9406313dc98a" ||
    runtime.policy.deploymentId !== "monad-testnet-3fc9997e-v1" ||
    runtime.policy.rpcUrls[1] !== "https://rpc-testnet.monadinfra.com"
  )
    throw new Error("Dormant outside the exact reviewed local testnet runtime");
  const policy = runtime.policy;
  const adapters = {
    ...runtime.adapters,
    sessionLimits: {
      ...runtime.adapters.sessionLimits,
      maxTransactions: 1,
      maxTotalFeeWei: 60000000000000000n,
    },
  };
  openButton.addEventListener("click", async () => {
    if (busy || attempted || repair || lifetime.signal.aborted) return;
    busy = true;
    controls();
    status.textContent =
      "Bruk den eksisterende primærnøkkelen. Deretter kontrolleres de krypterte kopiene og begge kjedeleverandørene.";
    try {
      const opened = await openPreparedCompletion(
        policy,
        pin,
        new MeraPasskeyAdapter(),
        adapters,
        lifetime.signal,
      );
      if (lifetime.signal.aborted) {
        opened.close();
        return;
      }
      repair = opened;
      preview.textContent = `Kontrollert lagret førsteversjon: «${repair.content.title}». Dette innholdet er ennå ikke registrert på kjeden.`;
      status.textContent =
        "Riktig eksisterende nøkkel og lagrede kopier er kontrollert. Du kan nå fullføre første registrering med knappen i trinn 2.";
    } catch (error) {
      errorNotice(error);
    } finally {
      busy = false;
      controls();
    }
  });
  completeButton.addEventListener("click", async () => {
    if (busy || attempted || !repair || lifetime.signal.aborted) return;
    attempted = true;
    busy = true;
    controls();
    status.textContent =
      "Kontrollerer oppsettet på nytt og sender høyst én testnet-transaksjon. La siden stå åpen.";
    try {
      show(await repair.complete());
    } catch (error) {
      errorNotice(error);
      if (repair.ticket)
        proof.textContent = JSON.stringify(repair.ticket, null, 2);
    } finally {
      busy = false;
      controls();
    }
  });
  checkButton.addEventListener("click", async () => {
    if (busy || !repair?.ticket || lifetime.signal.aborted) return;
    busy = true;
    controls();
    try {
      show(await repair.reconcile());
    } catch (error) {
      errorNotice(error);
    } finally {
      busy = false;
      controls();
    }
  });
  controls();
} catch (error) {
  errorNotice(error);
}
window.addEventListener("pagehide", () => {
  lifetime.abort();
  repair?.close();
  preview.textContent = "Økten er stengt.";
  controls();
});
