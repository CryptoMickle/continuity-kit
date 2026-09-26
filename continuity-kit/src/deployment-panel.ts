import type { WebAuthnClient } from "@category-labs/mera";
import proposal from "../testnet/deployment-proposal.json";
import {
  createDeploymentFetchRpc,
  createProposedDeploymentExecutor,
  validateProposedDeploymentApproval,
} from "../testnet/deployment-executor.ts";
import type { DeploymentTicket } from "../testnet/deployment-executor.ts";

declare const __DEPLOYMENT_OPERATOR_ACK__: boolean;

// Importing/rendering this entry performs no external I/O or authentication.
const plan = validateProposedDeploymentApproval({
  chainId: proposal.network.chainId,
  deployer: proposal.deployer,
  nonce: proposal.nonce,
  predictedContractAddress: proposal.predictedContractAddress,
  creationData: proposal.transaction.data,
  creationDataHash: proposal.creationDataKeccak256,
  runtimeCodeHash: proposal.expectedRuntimeCodeHash,
  gasLimitCeiling: proposal.limits.gasLimitCeiling,
  maxFeePerGasWei: proposal.limits.maxFeePerGasWei,
  maxPriorityFeePerGasWei: proposal.limits.maxPriorityFeePerGasWei,
  maxTotalFeeWei: proposal.limits.maxTotalFeeWei,
  valueWei: proposal.limits.valueWei,
});
const get = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const execute = get<HTMLButtonElement>("execute");
const reconcile = get<HTMLButtonElement>("reconcile");
const close = get<HTMLButtonElement>("close");
const download = get<HTMLButtonElement>("export");
const reviewed = get<HTMLInputElement>("reviewed");
const status = get<HTMLParagraphElement>("status");
let executor: ReturnType<typeof createProposedDeploymentExecutor> | undefined;
let attempted = false;
let busy = false;
let publicTicket: DeploymentTicket | undefined;
const enabled =
  typeof __DEPLOYMENT_OPERATOR_ACK__ !== "undefined" &&
  __DEPLOYMENT_OPERATOR_ACK__ === true &&
  location.origin === "http://primary.localhost:4176" &&
  window.isSecureContext;
get("proposal").textContent = JSON.stringify(proposal, null, 2);
reviewed.disabled = !enabled;
if (enabled)
  status.textContent =
    "ready — operatørstart bekreftet; manuell gjennomgang og handling gjenstår";
reviewed.addEventListener("change", () => {
  execute.disabled = !enabled || attempted || !reviewed.checked;
});

// Implements Mera's public interface with the browser API; private signing stays
// entirely in the reviewed executor. Credential creation is deliberately absent.
const browserClient: WebAuthnClient = {
  async createCredential() {
    throw new Error("DEPLOYMENT_CREATION_DISABLED");
  },
  async getCredential(request) {
    const credential = await navigator.credentials.get({
      publicKey: {
        rpId: request.rpId,
        challenge: request.challenge,
        userVerification: request.userVerification,
        timeout: request.timeout,
        ...(request.allowCredential
          ? {
              allowCredentials: [
                {
                  type: "public-key" as const,
                  id: request.allowCredential.credentialId,
                },
              ],
            }
          : {}),
        extensions: {
          prf: { eval: { first: request.prfSalt } },
        } as AuthenticationExtensionsClientInputs,
      },
    });
    if (!(credential instanceof PublicKeyCredential))
      throw new Error("DEPLOYMENT_CREDENTIAL");
    const extensions =
      credential.getClientExtensionResults() as AuthenticationExtensionsClientOutputs & {
        prf?: { results?: { first?: ArrayBuffer } };
      };
    const output = extensions.prf?.results?.first;
    return {
      credentialId: new Uint8Array(credential.rawId),
      ...(output ? { prfOutput: new Uint8Array(output) } : {}),
    };
  },
};
function refreshTicket() {
  publicTicket = executor?.ticket();
  get("ticket").textContent = publicTicket
    ? JSON.stringify(publicTicket, null, 2)
    : "Ingen offentlig transaksjonsbillett.";
  download.disabled = !publicTicket;
  reconcile.disabled = !publicTicket || busy;
}
execute.addEventListener("click", async () => {
  if (!enabled || attempted || !reviewed.checked) return;
  attempted = true;
  busy = true;
  execute.disabled = true;
  reviewed.disabled = true;
  status.textContent =
    "reserving — ett forsøk reserveres for denne operatørserveren";
  try {
    const reservation = await fetch("/__deployment_attempt", {
      method: "POST",
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
    });
    if (!reservation.ok) throw new Error("DEPLOYMENT_RESERVATION");
    executor = createProposedDeploymentExecutor(plan, {
      rpc: createDeploymentFetchRpc(window.fetch.bind(window)),
      webAuthnClient: browserClient,
      now: Date.now,
    });
    close.disabled = false;
    status.textContent =
      "executing — preflight, brukerens passnøkkelprompt og høyst én sending; ikke last siden på nytt";
    const outcome = await executor.execute();
    status.textContent = outcome.status;
  } catch {
    status.textContent =
      "stopped — ingen automatisk ny sending; eventuell billett må avklares før nytt forsøk";
  } finally {
    busy = false;
    refreshTicket();
  }
});
reconcile.addEventListener("click", async () => {
  if (!executor || busy || !publicTicket) return;
  busy = true;
  reconcile.disabled = true;
  status.textContent =
    "reconciling — kun lesing av samme hash hos begge tilbydere";
  try {
    status.textContent = (await executor.reconcile()).status;
  } catch {
    status.textContent = "evidence-invalid — kontrollen kunne ikke fullføres";
  } finally {
    busy = false;
    refreshTicket();
  }
});
close.addEventListener("click", () => {
  executor?.close();
  close.disabled = true;
  status.textContent =
    "closed — videre sending stengt; sendt transaksjon kan ikke trekkes tilbake; billett kan fortsatt kontrolleres";
});
download.addEventListener("click", () => {
  if (!publicTicket) return;
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(publicTicket, null, 2) + "\n"], {
      type: "application/json",
    }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = `continuity-deployment-${publicTicket.transactionHash}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
window.addEventListener("pagehide", () => executor?.close());
