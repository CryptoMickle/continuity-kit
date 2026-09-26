import "./style.css";
import { validateContext } from "./sdk/policy.ts";
import { createRuntime } from "./runtime.ts";
import { MeraPasskeyAdapter } from "./sdk/passkeys.ts";
import { SyntheticWebAuthnClient } from "./sdk/demo-fixture.ts";
import { createPrimary } from "./sdk/account.ts";
import type { PrimaryAccount, PrimaryState } from "./sdk/account.ts";
import {
  prepareBackup,
  finalizeEnrollment,
  restorePrimary,
  discoverRecovery,
  recoverCurrent,
  saveCheckpoint,
  reconcileCheckpoint,
  reconcileEnrollment,
} from "./sdk/index.ts";
import type {
  PreparedBackup,
  WriteTicket,
  WriteProof,
  Recovered,
  Workspace,
  Context,
} from "./sdk/types.ts";
import { HandoffChannel } from "./handoff.ts";

declare const __CONTINUITY_TESTNET_CONFIG__: unknown;
const runtime = createRuntime(
  typeof __CONTINUITY_TESTNET_CONFIG__ === "undefined"
    ? undefined
    : __CONTINUITY_TESTNET_CONFIG__,
);
const policy = runtime.policy;
const chainRun = runtime.kind === "monad-testnet";
const adapters = runtime.adapters;
const isRecovery = location.origin === policy.bOrigin;
const validOrigin = isRecovery || location.origin === policy.aOrigin;
const query = new URLSearchParams(location.search);
const physicalEnabled =
  import.meta.env.VITE_ENABLE_PHYSICAL_PASSKEYS === "true";
const physical =
  runtime.requirePhysicalPasskeys ||
  (physicalEnabled && query.get("mode") === "physical");
const fixture = new SyntheticWebAuthnClient({
  seed: "continuity-demo-profile-1",
});
const passkeys = new MeraPasskeyAdapter(physical ? undefined : fixture);
const app = document.querySelector<HTMLDivElement>("#app")!;
let primary: PrimaryAccount | null = null;
let state: PrimaryState | null = null;
let recovered: Recovered | null = null;
let backup: PreparedBackup | null = null;
let pendingTicket: WriteTicket | null = null;
let writeProof: WriteProof | null = null;
let offer: { context: Context; dataKey: Uint8Array } | null = null;
let channel: HandoffChannel | null = null;
let busy = false;
let enrollmentPending = false;
let reserveConfirmed = false;
let toolsOpen = false;
let actionTail = Promise.resolve();
let primaryOnline = true;
let scenario = "healthy";
let localEdited = false;
let notice = {
  tone: "neutral",
  title: isRecovery
    ? "Recovery has not been checked yet."
    : "A small workspace. A durable way back.",
  text: isRecovery
    ? "Use a recovery passkey only after completing reserve setup in the primary app. This screen does not confirm that a reserve exists."
    : "Prepare a reserve before your first protected checkpoint.",
};
let workspace: Workspace = {
  title: "The next expedition",
  plan: "Build a small product people can trust with work they do not want to lose.",
  tasks: [
    { id: "proof", text: "Prove the recovery path", done: true },
    { id: "latest", text: "Keep the latest checkpoint honest", done: false },
    { id: "review", text: "Let another developer try it", done: false },
  ],
  draft:
    "A great recovery flow should feel ordinary. Open a separate client, use the reserve you prepared, and find your work exactly where you left it.",
};
const escape = (value: unknown) =>
  String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const short = (value: string) => `${value.slice(0, 10)}…${value.slice(-6)}`;
const icon = (kind: string) =>
  kind === "arrow" ? "↗" : kind === "check" ? "✓" : kind === "lock" ? "◈" : "↳";
const modeQuery = physical ? "?mode=physical" : "";
const errorMessages: Record<string, [string, string]> = {
  AUTH_CANCELLED: [
    "Authentication did not finish",
    "This action did not commit a checkpoint. A passkey created before cancellation may still be on your device. Complete any additional verification prompt when you retry.",
  ],
  PRF_UNAVAILABLE: [
    "This authenticator cannot unlock this reserve",
    "PRF support is required. Try the documented supported setup; no substitute key has been generated.",
  ],
  NO_RECOVERY_MATERIAL: [
    isRecovery
      ? "No matching reserve was found"
      : "Primary passkey opened. No saved setup was found.",
    isRecovery
      ? "The selected credential has no available reserve index. A missing copy and a different credential can look the same."
      : "Your passkey worked, but its saved workspace setup could not be loaded. Check whether reserve setup finished and whether this is the original app key you used. Keep existing keys; creating another key will not restore this workspace.",
  ],
  MANIFEST_INVALID: [
    "The reserve metadata could not be verified",
    "Neither configured copy provided an authentic, valid reserve. No content was opened.",
  ],
  CURRENT_DATA_UNAVAILABLE: [
    "The latest checkpoint is unavailable",
    "The registry identifies the current version, but neither mirror returned its exact bytes. An older copy will not be shown as current.",
  ],
  FRESHNESS_UNAVAILABLE: [
    "Currentness cannot be checked",
    "The registry is unavailable or its evidence is invalid. Restore the registry before opening a checkpoint.",
  ],
  WRITE_CONFLICT: [
    "Another save got there first",
    "Your unsaved text remains here. Restore the latest checkpoint before resolving the difference.",
  ],
  ENROLLMENT_CONFLICT: [
    "This demo credential already has a reserve",
    "Choose “Open existing workspace” to open the existing workspace. A credential is never rebound to a different workspace.",
  ],
  SESSION_EXPIRED: [
    "Your signing session has ended",
    "Restore the primary account to start another scoped session. Your current text remains in this window.",
  ],
  HEAD_MOVED: [
    "The checkpoint kept changing",
    "Recovery stopped rather than label an outdated read current. Try again when saves have settled.",
  ],
};
function fail(error: unknown) {
  const code =
    error && typeof error === "object" && "code" in error
      ? String(error.code)
      : "ACTION_FAILED";
  const message = errorMessages[code] ?? [
    "The action could not be completed",
    "No successful recovery or save is being claimed. Check the local services and try again.",
  ];
  notice = {
    tone: "error",
    title: message[0],
    text: `${message[1]} (${code})`,
  };
}
async function run(action: () => Promise<void>, required = false) {
  if (busy && !required) return;
  const previous = actionTail;
  let finish!: () => void;
  actionTail = new Promise<void>((resolve) => {
    finish = resolve;
  });
  await previous;
  busy = true;
  render();
  try {
    await action();
  } catch (error) {
    pendingTicket = (state ?? primary)?.writer.pendingTicket ?? pendingTicket;
    fail(error);
  } finally {
    busy = false;
    finish();
    render();
  }
}
async function control(change: Record<string, unknown>) {
  const response = await fetch(`${runtime.controlUrl}/v1/control`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(change),
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error("Local controls unavailable");
  const result = await response.json();
  primaryOnline = result.primaryOnline;
  scenario = result.scenario;
}
async function refreshStatus() {
  try {
    const response = await fetch(`${runtime.controlUrl}/v1/status`, {
      signal: AbortSignal.timeout(3000),
    });
    const status = await response.json();
    primaryOnline = status.primaryOnline;
    scenario = status.scenario;
    render();
  } catch {
    /* Explicit operations expose service failures. */
  }
}
function editorMarkup() {
  return `<div class="document-head"><div><span class="eyebrow">${isRecovery ? "RECOVERED WORKSPACE" : "PRIVATE WORKSPACE"}</span><h2>${isRecovery ? "Your work, returned." : "Make something worth keeping."}</h2></div><span class="document-symbol">▤</span></div>
    <label class="field title-field">Workspace title<input id="title" maxlength="200" value="${escape(workspace.title)}" ${busy || enrollmentPending ? "disabled" : ""}></label>
    <label class="field">The plan<textarea id="plan" rows="2" maxlength="16000" ${busy || enrollmentPending ? "disabled" : ""}>${escape(workspace.plan)}</textarea></label>
    <span class="field-label">Next steps</span><div class="tasks">${workspace.tasks.map((task, i) => `<label class="task"><input type="checkbox" data-task="${i}" ${busy || enrollmentPending ? "disabled" : ""} ${task.done ? "checked" : ""}><span>${escape(task.text)}</span></label>`).join("")}</div>
    <label class="field">Working draft<textarea id="draft" rows="5" maxlength="64000" ${busy || enrollmentPending ? "disabled" : ""}>${escape(workspace.draft)}</textarea></label>
    <div class="document-footer"><span id="edit-state">${localEdited ? "Local changes · not committed" : recovered ? `Verified checkpoint v${escape(recovered.version)}` : "Sample content · held in this window"}</span>${isRecovery ? '<button class="button dark" id="export">Export local copy ↗</button>' : `<button class="button dark" id="save" ${!state || busy ? "disabled" : ""}>Save checkpoint ${icon("arrow")}</button>`}</div>`;
}
function proofMarkup() {
  if (!recovered)
    return '<div class="empty-proof"><span class="proof-ring">◎</span><p>A successful recovery comes with a receipt.</p><small>The selected version, digest and source checks appear here.</small></div>';
  return `<div class="verified-label">✓ ${recovered.evidence.trustMode === "local-model" ? "VERIFIED IN LOCAL MODEL" : "VERIFIED THROUGH FINALIZED RPC QUORUM"}</div><div class="version-number">v${escape(recovered.version)}<span>current at the accepted read</span></div><dl><dt>Owner</dt><dd title="${escape(recovered.context.owner)}">${short(recovered.context.owner)}</dd><dt>Checkpoint</dt><dd title="${escape(recovered.capsuleDigest)}">${short(recovered.capsuleDigest)}</dd><dt>${recovered.evidence.trustMode === "local-model" ? "Model" : "Finalized"} block</dt><dd>${escape(recovered.evidence.blockNumber)}</dd><dt>Checked</dt><dd>${new Date(recovered.evidence.observedAt).toLocaleTimeString()}</dd></dl>${recovered.diagnostics.length ? `<div class="mirror-warning">${recovered.diagnostics.length} invalid or unavailable mirror response(s) rejected. A valid copy passed all checks.</div>` : '<p class="proof-footnote">The exact stored bytes match the owner-approved digest.</p>'}<details><summary>Inspect verification receipt</summary><pre>${escape(JSON.stringify({ ...recovered, content: undefined, writeProof }, null, 2))}</pre></details>`;
}
function guideMarkup() {
  const a = new URL(policy.aOrigin).hostname;
  const b = new URL(policy.bOrigin).hostname;
  let label: string, title: string, text: string;
  if (busy) {
    label = "IN PROGRESS";
    title = "Finish the current action.";
    text = physical
      ? "Follow any device prompt already open, then wait for the result here. Your device may ask for more than one confirmation. Do not start another action yet."
      : "The simulated action is running. No device confirmation is needed; wait for the result here.";
  } else if (notice.tone === "error") {
    label = "ACTION NEEDS ATTENTION";
    title = "Check the message above before continuing.";
    text =
      "The last action did not finish successfully. Keep your existing passkeys; creating another key will not recover missing work.";
  } else if (pendingTicket) {
    label = "WAITING FOR CONFIRMATION";
    title = "Check the existing transaction.";
    text =
      "Use Check transaction status below. This reads the result without signing or sending another transaction.";
  } else if (isRecovery && recovered) {
    label = "WORK RECOVERED";
    title = "Your saved work is open.";
    text =
      "You can edit this local copy and export it. These edits do not change the saved checkpoint.";
  } else if (isRecovery && reserveConfirmed) {
    label = "SETUP COMPLETE";
    title = "Your reserve is ready.";
    text = `Keep your ${b} passkey. Setup is finished; use this key whenever you need to open your saved work here.`;
  } else if (isRecovery && offer) {
    label = "SETUP · STEP 2 OF 2";
    title = "Create the reserve app’s passkey.";
    text = `Choose Create recovery passkey below and save a new key for ${b}. It is separate from your ${a} key. Wait for “Reserve prepared and independently checked”.`;
  } else if (enrollmentPending) {
    label = "SETUP IN PROGRESS";
    title = isRecovery
      ? "Waiting for setup to finish."
      : "Continue in the reserve window.";
    text = isRecovery
      ? "Keep both windows open while the apps finish checking the reserve. A saved passkey alone does not mean setup is complete."
      : `In the ${b} window, choose Create recovery passkey. Keep this window open until both apps confirm the reserve is ready.`;
  } else if (isRecovery) {
    label = "OPEN EXISTING WORK";
    title = "Use your reserve app’s passkey.";
    text = `Choose Recover with passkey below, then use the existing key for ${b}. If your device says no key is saved, check the device or password manager used during setup; do not create another key to recover this work.`;
  } else if (state) {
    label = "RESERVE READY";
    title = "Save changes as you work.";
    text =
      "Use Save checkpoint to protect the latest changes. Unsaved edits are held only in this window.";
  } else if (primary) {
    label = "SETUP · STEP 2 OF 2";
    title = "Open the reserve app.";
    text = `Your original app key is ready. Choose Open recovery setup to prepare a separate key for ${b}. Your reserve is not ready yet.`;
  } else {
    label = "SETUP · STEP 1 OF 2";
    title = "Create the original app’s passkey.";
    text = `Choose Create primary passkey and save a new key for ${a}. Already completed setup? Choose Open existing workspace instead, using your existing ${a} key.`;
  }
  if (
    chainRun &&
    primary &&
    !state &&
    !busy &&
    !enrollmentPending &&
    !isRecovery &&
    notice.tone !== "error"
  )
    text +=
      " First fund the test account shown above using the approved free test-token process. Completing reserve setup submits its first testnet transaction.";
  if (!physical)
    text =
      text
        .replaceAll("Create primary passkey", "Create demo account")
        .replaceAll("Create recovery passkey", "Prepare simulated reserve")
        .replaceAll("Recover with passkey", "Recover demo workspace") +
      " This simulation uses public test credentials.";
  return `<section class="step-guide" aria-label="Your next step"><span class="eyebrow">${escape(label)}</span><h2>${escape(title)}</h2><p>${escape(text)}</p>${physical && !recovered && !reserveConfirmed && !state ? "<small>Your device may ask for more than one confirmation. Finish any open prompt before starting another action.</small>" : ""}</section>`;
}
function render() {
  const tools = document.querySelector<HTMLDetailsElement>("#test-tools");
  if (tools) toolsOpen = tools.open;
  if (!validOrigin) {
    app.innerHTML =
      '<main style="padding:60px"><h1>Open the configured client</h1><p>This origin is not part of the recovery policy.</p><a href="http://primary.localhost:4173">Open primary.localhost</a></main>';
    return;
  }
  app.innerHTML = `<div class="shell"><aside class="sidebar"><a class="brand" href="${policy.aOrigin}${modeQuery}"><span class="brand-mark"><i></i><i></i><i></i></span>continuity<span>kit</span></a><div class="side-caption">WORK THAT STAYS WITH YOU</div><nav><a class="${!isRecovery ? "active" : ""}" href="${policy.aOrigin}${modeQuery}"><span>▤</span> Primary workspace <small>A</small></a><a class="${isRecovery ? "active" : ""}" href="${policy.bOrigin}${modeQuery}"><span>↳</span> Recovery client <small>B</small></a></nav><div class="side-story"><div class="orbit">↳</div><h3>Apps can disappear.<br>Your work shouldn’t.</h3><p>An independent reserve.<br>A verifiable latest copy.<br>A way to keep going.</p></div><div class="side-bottom"><span class="dot"></span> ${physical ? "Physical passkeys" : "Synthetic credentials"}<br><small>Local demonstration · v0.1</small></div></aside>
  <main><header class="topbar"><div><span class="status-dot ${primaryOnline ? "" : "offline"}"></span> Primary ${primaryOnline ? "available" : "offline"}<span class="top-separator">/</span><span>${isRecovery ? "Independent recovery origin" : "Primary origin"}</span></div><span class="mode-tag">${chainRun ? "MONAD TESTNET · LOCAL STORES" : physical ? "PHYSICAL TEST · LOCAL REGISTRY" : "LOCAL SIMULATION"}</span></header>
  <section class="hero"><div><span class="eyebrow">CONTINUITY, BY DESIGN</span><h1>${isRecovery ? "Bring your work back." : "Your work has a way back."}</h1><p>${isRecovery ? "The original app can be gone. Your prepared reserve can still open the latest surviving checkpoint." : "A private workspace with a reserve you prepare today, for the app you might lose tomorrow."}</p></div><div class="hero-badge"><span>${isRecovery ? "B" : "A"}</span><small>${isRecovery ? "RECOVER" : "CREATE"}</small></div></section>
  <div class="notice ${notice.tone}" role="status" aria-live="polite"><span>${busy ? "◌" : notice.tone === "error" ? "!" : notice.tone === "success" ? "✓" : "↳"}</span><div><strong>${escape(notice.title)}</strong><p>${escape(notice.text)}</p></div></div>
  ${chainRun ? `<section class="boundary-card"><h3>Monad testnet · separate setup</h3><p>This run uses real testnet transactions and two encrypted copies in one local service. Create a new passkey pair for this setup; the earlier local reserve stays bound to its original registry.</p><p>Registry: <code>${escape(policy.registryAddress)}</code></p>${!isRecovery && primary ? `<p>Test account to fund before reserve setup: <code>${escape(primary.context.owner)}</code></p>` : ""}</section>` : ""}
  ${guideMarkup()}
  <section class="content-grid"><article class="document">${!isRecovery || recovered ? editorMarkup() : `<div class="recovery-empty"><div class="recovery-art"><span>▤</span><i>↳</i><b>✓</b></div><span class="eyebrow">${offer ? "PREPARE YOUR INDEPENDENT RESERVE" : "START FROM A FRESH CLIENT"}</span><h2>${offer ? "A separate key. A second way in." : "No old tab. No saved file."}</h2><p>${offer ? "This client will wrap a separate data key. It receives no primary wallet key or permission to write its history." : "Choose your prepared recovery credential. The client discovers the encrypted reserve and verifies which copy is current."}</p><button class="button dark large" id="${offer ? "enroll" : "recover"}" ${busy ? "disabled" : ""}>${offer ? (physical ? "Create recovery passkey" : "Prepare simulated reserve") : physical ? "Recover with passkey" : "Recover demo workspace"} ↗</button><small>${physical ? "Use the passkey for recovery.localhost. Your device may ask for more than one confirmation." : "Uses public test credentials. Do not put private information in this demo."}</small></div>`}</article>
  <aside class="right-stack"><section class="reserve-card"><div class="card-kicker">${isRecovery ? "RECOVERY RECEIPT" : "INDEPENDENT RESERVE"}<span>↗</span></div>${isRecovery ? proofMarkup() : `<div class="reserve-illustration"><div>A</div><span>╌╌╌<i>◈</i>╌╌╌</span><div>B</div></div><h2>${state ? "Your reserve is prepared." : "Give your work a second home."}</h2><p>${state ? "Checkpoint updates use the same reserve. Your primary signing session is scoped and expires after ten minutes." : "A separate credential protects the data key. Two encrypted copies and a version registry complete the path back."}</p><button class="button pale" id="prepare" ${busy || enrollmentPending || !!state ? "disabled" : ""}>${state ? "✓ Reserve prepared" : primary ? "Open recovery setup" : physical ? "Create primary passkey" : "Create demo account"}</button><button class="text-button" id="restore" ${busy || enrollmentPending || (!!primary && !state) ? "disabled" : ""}>Open existing workspace ↗</button>`}</section>
  <section class="boundary-card"><span class="mini-icon">◈</span><h3>${isRecovery ? "Your copy, your next step." : "Private content stays encrypted."}</h3><p>${isRecovery ? "Read, edit locally and export. Recovery does not restore the primary wallet or authorize new registry writes." : chainRun ? "The local stores receive ciphertext. Monad testnet receives the version and digest. These two local copies do not demonstrate independent hosting." : "The stores receive ciphertext. The registry receives a version and digest. The registry in this demonstration is a local model."}</p></section></aside></section>
  <details class="test-tools" id="test-tools" ${toolsOpen ? "open" : ""}><summary>Demonstration tools · outages and verification tests</summary><section class="demo-controls"><div><span class="eyebrow">TRY THE FAILURE, TOO</span><h2>Recovery should earn your trust.</h2><p>Change the conditions. Then run recovery in a fresh client.</p></div><div class="controls"><label>Mirror / registry condition<select id="scenario" ${busy || enrollmentPending ? "disabled" : ""}><option value="healthy">Both copies healthy</option><option value="stale-one">Mirror 1 serves an old valid copy</option><option value="stale-both">Both mirrors serve an old valid copy</option><option value="missing-current">Latest bytes unavailable</option>${chainRun ? "" : '<option value="freshness-offline">Registry unavailable</option>'}<option value="corrupt-index">Reserve metadata corrupted</option></select></label><button class="button outline" id="outage" ${busy || enrollmentPending ? "disabled" : ""}>${primaryOnline ? "Take primary offline" : "Bring primary back"}</button><button class="text-button" id="fresh" ${busy ? "disabled" : ""}>Discard this session & reload ↻</button>${isRecovery && recovered ? `<button class="button dark" id="recover-again" ${busy ? "disabled" : ""}>Check recovery again ↗</button>` : ""}</div></section></details>
  ${!isRecovery && pendingTicket ? '<section class="boundary-card"><h3>Transaction confirmation is unresolved.</h3><p>Your draft remains here. Checking status only reads the registry; it never submits another transaction.</p><button class="button outline" id="check-transaction">Check transaction status</button><button class="text-button" id="export-ticket">Export transaction reference</button></section>' : ""}
  <footer><span>ContinuityKit / Experimental developer preview</span><span>${chainRun ? "Physical passkeys · Monad testnet 10143 · local encrypted stores" : (physical ? "Real authenticator · simulated registry" : "Simulated authenticator · simulated registry") + " · No Monad transactions"}</span></footer>
  </main></div>`;
  document.querySelector("#check-transaction")?.addEventListener(
    "click",
    () =>
      void run(async () => {
        const account = state ?? primary;
        if (!account || !pendingTicket) return;
        if (pendingTicket.command.operation === "create") {
          const result = await reconcileEnrollment(
            account,
            pendingTicket,
            adapters,
          );
          if (result.status === "pending") {
            notice = {
              tone: "neutral",
              title: "Reserve confirmation is still pending.",
              text: "Your enrollment and transaction reference remain unchanged.",
            };
            return;
          }
          state = result.state;
          notifyReserveCommitted({
            version: result.currentHead.version,
            capsuleDigest: result.currentHead.capsuleDigest,
          });
          enrollmentPending = false;
          pendingTicket = result.unresolvedTicket ?? null;
          writeProof = result.proof;
          // Keep the draft; a status check never treats it as newly recovered current content.
          recovered = null;
          notice = {
            tone: pendingTicket ? "neutral" : "success",
            title: pendingTicket
              ? "Reserve prepared; transaction attribution remains unresolved."
              : "Reserve prepared and transaction confirmed.",
            text: "Your draft remains here. Restore or recover to open the verified current checkpoint.",
          };
          return;
        }
        if (!state) return;
        const result = await reconcileCheckpoint(
          state,
          pendingTicket,
          adapters,
        );
        if (result.status === "pending") {
          notice = {
            tone: "neutral",
            title: "Checkpoint confirmation is still pending.",
            text: "Your draft and transaction reference remain here. No new transaction was sent.",
          };
          return;
        }
        writeProof = result.proof;
        pendingTicket =
          result.status === "saved" ? (result.unresolvedTicket ?? null) : null;
        if (result.status === "saved") recovered = result.recovered;
        notice = {
          tone: pendingTicket ? "neutral" : "success",
          title: pendingTicket
            ? "Checkpoint found; transaction attribution remains unresolved."
            : "Transaction confirmed.",
          text:
            result.status === "saved"
              ? "The exact checkpoint is current at the accepted read. Your text in this window remains unchanged."
              : "A newer checkpoint is current. Your draft remains here; restore or recover to read the latest content.",
        };
      }),
  );
  document.querySelector("#export-ticket")?.addEventListener("click", () => {
    if (!pendingTicket) return;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(pendingTicket, null, 2)], {
        type: "application/json",
      }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "continuity-transaction-reference.json";
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  const select = document.querySelector<HTMLSelectElement>("#scenario");
  if (select)
    select.value =
      chainRun && scenario === "freshness-offline" ? "healthy" : scenario;
  document
    .querySelector("#prepare")
    ?.addEventListener("click", startEnrollment);
  document
    .querySelector("#enroll")
    ?.addEventListener("click", () => void run(enrollRecovery));
  document
    .querySelector("#recover")
    ?.addEventListener("click", () => void run(recover));
  document
    .querySelector("#recover-again")
    ?.addEventListener("click", () => void run(recover));
  document.querySelector("#restore")?.addEventListener(
    "click",
    () =>
      void run(async () => {
        primary?.close();
        const restored = await restorePrimary(policy, passkeys, adapters);
        state = restored.state;
        primary = state;
        setRecovered(restored.recovered);
        notice = {
          tone: "success",
          title: "Same account. Same private workspace.",
          text: chainRun
            ? "Recovered from the primary credential and encrypted stores. The current checkpoint passed finalized Monad testnet RPC checks."
            : "Recovered from the primary credential and encrypted stores, with no saved browser state. This is local-model evidence.",
        };
      }),
  );
  document.querySelector("#save")?.addEventListener(
    "click",
    () =>
      void run(async () => {
        if (!state) return;
        const next = await saveCheckpoint(state, workspace, adapters);
        if (next.status === "pending") {
          pendingTicket = next.ticket;
          notice = {
            tone: "neutral",
            title: "Checkpoint confirmation is pending.",
            text: "Your draft remains here. Check transaction status before saving again.",
          };
          return;
        }
        if (next.status === "superseded") {
          writeProof = next.proof;
          notice = {
            tone: "neutral",
            title: "A newer checkpoint is available.",
            text: "Your write committed, then another checkpoint replaced it. Your draft remains here; restore to read the current checkpoint.",
          };
          return;
        }
        pendingTicket = next.unresolvedTicket ?? null;
        writeProof = next.proof;
        setRecovered(next.recovered);
        notice = {
          tone: "success",
          title: `Checkpoint v${next.recovered.version} is committed.${pendingTicket ? " Transaction confirmation is unresolved." : ""}`,
          text:
            next.proof.kind === "local-model"
              ? "Both exact encrypted copies were checked before the signed local registry update."
              : next.proof.kind === "finalized-state"
                ? "The finalized registry contains this checkpoint. Its transaction attribution remains unresolved; check its status before another save."
                : "The transaction, event and finalized registry state passed the configured RPC checks.",
        };
      }),
  );
  document.querySelector("#export")?.addEventListener("click", exportCopy);
  select?.addEventListener(
    "change",
    () =>
      void run(async () => {
        await control({ scenario: select.value });
        notice = {
          tone: "neutral",
          title: "Test condition changed.",
          text: "Recover again to observe the result. Previously displayed evidence describes its earlier accepted read.",
        };
      }),
  );
  document.querySelector("#outage")?.addEventListener(
    "click",
    () =>
      void run(async () => {
        await control({ primaryOnline: !primaryOnline });
        notice = {
          tone: "neutral",
          title: primaryOnline
            ? "Primary is available again."
            : "Primary pages and backend are now offline.",
          text: primaryOnline
            ? "The independent recovery client remains available."
            : "Open the recovery client and discard its session before recovery. This loaded tab may still display its old in-memory view.",
        };
      }),
  );
  document.querySelector("#fresh")?.addEventListener("click", () => {
    primary?.close();
    channel?.close();
    offer?.dataKey.fill(0);
    location.replace(`${location.origin}${modeQuery}`);
  });
  for (const field of ["title", "plan", "draft"] as const)
    document
      .querySelector<HTMLInputElement | HTMLTextAreaElement>(`#${field}`)
      ?.addEventListener("input", (event) => {
        workspace[field] = (event.target as HTMLInputElement).value;
        markEdited();
      });
  document.querySelectorAll<HTMLInputElement>("[data-task]").forEach((input) =>
    input.addEventListener("change", () => {
      workspace.tasks[Number(input.dataset.task)]!.done = input.checked;
      markEdited();
    }),
  );
}
function markEdited() {
  localEdited = true;
  const el = document.querySelector("#edit-state");
  if (el)
    el.textContent = isRecovery
      ? "Local working copy · source receipt unchanged"
      : "Unsaved local changes";
}
function setRecovered(value: Recovered) {
  recovered = value;
  workspace = structuredClone(value.content);
  localEdited = false;
}
async function recover() {
  recovered = null;
  const discovered = await discoverRecovery(policy, passkeys, adapters);
  const result = await recoverCurrent(discovered, passkeys, adapters);
  setRecovered(result);
  notice = {
    tone: "success",
    title: `Your latest verified work is here. Version ${result.version}.`,
    text: result.diagnostics.length
      ? "An invalid mirror response was rejected. A surviving exact copy passed verification."
      : "The independent client discovered the reserve and opened the current exact copy.",
  };
}
function watchEnrollment(bound: HandoffChannel, peer: Window) {
  const started = Date.now();
  const timer = setInterval(() => {
    if (channel !== bound || !enrollmentPending) {
      clearInterval(timer);
      return;
    }
    if (peer.closed || Date.now() - started >= 300000) {
      clearInterval(timer);
      enrollmentPending = false;
      bound.close();
      offer?.dataKey.fill(0);
      offer = null;
      if (!state) primary?.close();
      notice = {
        tone: "error",
        title: peer.closed
          ? "The other enrollment window closed."
          : "Reserve preparation expired.",
        text: "Preparation has not been confirmed here. Any passkey already created may remain on your device. Discard this session before a new enrollment.",
      };
      render();
    }
  }, 500);
}
function notifyReserveCommitted(head: {
  version: string;
  capsuleDigest: string;
}) {
  // A finalized registry result survives a closed or expired popup. Notify once;
  // B still checks the registry itself, or can recover independently in a fresh tab.
  const completedChannel = channel;
  channel = null;
  if (!completedChannel) return;
  try {
    completedChannel.committed(head);
  } catch {
    // Delivery is optional once the enrollment is independently verifiable.
  } finally {
    completedChannel.close();
  }
}
function startEnrollment() {
  if (busy || enrollmentPending) return;
  if (!primary) {
    notice = {
      tone: "neutral",
      title: physical
        ? "Create your primary test passkey."
        : "Creating the public demo account.",
      text: physical
        ? "Keep this window active. After saving the passkey, the browser may ask you to use it once more for verification."
        : "No real credential is created in simulation mode.",
    };
    void run(async () => {
      primary = await createPrimary(policy, passkeys, adapters);
      notice = {
        tone: "success",
        title: "Primary account ready. Now prepare its reserve.",
        text: "Choose “Open recovery setup” to continue on the independent origin. No protected checkpoint exists yet.",
      };
    });
    return;
  }
  const popup = window.open(
    `${policy.bOrigin}/?enroll=1${physical ? "&mode=physical" : ""}`,
    "continuity-reserve",
  );
  if (!popup) {
    notice = {
      tone: "error",
      title: "Allow the reserve window to open.",
      text: "The two origins use a direct, origin-bound handoff. Then try preparation again.",
    };
    render();
    return;
  }
  channel?.close();
  enrollmentPending = true;
  channel = new HandoffChannel({
    role: "primary",
    peer: popup,
    origin: policy.bOrigin,
    send: (data, origin) => popup.postMessage(data, origin),
  });
  channel.setOffer({
    context: primary.context,
    dataKey: new Uint8Array(primary.dataKey),
  });
  watchEnrollment(channel, popup);
  notice = {
    tone: "neutral",
    title: "Continue in the recovery window.",
    text: "Confirm reserve preparation there. No checkpoint is protected until both copies and the registry are verified.",
  };
  render();
}
async function enrollRecovery() {
  if (!offer || !channel) throw new Error("No bound enrollment");
  validateContext(offer.context, policy);
  backup = await prepareBackup(policy, passkeys, offer);
  offer.dataKey.fill(0);
  offer = null;
  channel.backup(backup);
  notice = {
    tone: "neutral",
    title: "Reserve wrapped. Waiting for the primary commit.",
    text: "Preparation is incomplete until the encrypted copies and version registry are verified.",
  };
}
window.addEventListener("message", (event) => {
  const delivery = channel?.accept(event);
  if (!delivery) return;
  if (delivery.kind === "offer" && isRecovery) {
    try {
      const received = delivery.payload as {
        context: Context;
        dataKey: Uint8Array;
      };
      validateContext(received.context, policy);
      if (
        !(received.dataKey instanceof Uint8Array) ||
        received.dataKey.length !== 32
      )
        throw new Error("Invalid handoff key");
      offer = {
        context: received.context,
        dataKey: new Uint8Array(received.dataKey),
      };
      enrollmentPending = true;
      notice = {
        tone: "neutral",
        title: "The primary app requested a reserve.",
        text: `Source: ${policy.aOrigin}. This is a separate recovery credential for private app content.`,
      };
      render();
    } catch (error) {
      channel?.close();
      fail(error);
      render();
    }
  }
  if (delivery.kind === "backup" && !isRecovery)
    void run(async () => {
      if (!primary || !channel) throw new Error("Primary session missing");
      backup = delivery.payload as PreparedBackup;
      const result = await finalizeEnrollment(
        primary,
        backup,
        workspace,
        adapters,
      );
      if (result.status === "pending") {
        pendingTicket = result.ticket;
        notice = {
          tone: "neutral",
          title: "Reserve confirmation is pending.",
          text: "Preparation has not been confirmed. Your enrollment bytes remain unchanged.",
        };
        return;
      }
      state = result.state;
      writeProof = result.proof;
      pendingTicket = result.unresolvedTicket ?? null;
      const head = result.currentHead;
      // The enrollment draft belongs only to the exact v1 capsule, never a later head.
      recovered =
        head.version === "1" &&
        head.capsuleDigest === primary.enrollment?.capsuleDigest
          ? {
              content: structuredClone(workspace),
              context: state.context,
              manifestDigest: state.manifestDigest,
              version: head.version,
              capsuleDigest: head.capsuleDigest,
              evidence: head.evidence,
              diagnostics: [],
            }
          : null;
      notifyReserveCommitted({
        version: head.version,
        capsuleDigest: head.capsuleDigest,
      });
      enrollmentPending = false;
      notice = {
        tone: "success",
        title: pendingTicket
          ? "Reserve prepared; transaction confirmation is unresolved."
          : `Your reserve is prepared. Checkpoint v${head.version} is current.`,
        text:
          head.version !== "1"
            ? "A newer checkpoint has already replaced the enrollment draft. Restore or recover to read its verified content."
            : pendingTicket
              ? "The finalized registry confirms the reserve. Check transaction status before saving another checkpoint."
              : "Edit the workspace and save v2. Then take the primary offline and open a fresh recovery client.",
      };
    }, true);
  if (delivery.kind === "committed" && isRecovery)
    void run(async () => {
      if (!backup) throw new Error("Reserve missing");
      const head = await adapters.registry.getHead(
        backup.manifest.context.owner,
        backup.manifest.context.streamId,
      );
      const committed = delivery.payload as {
        version: string;
        capsuleDigest: string;
      };
      if (
        !head.exists ||
        head.manifestDigest !== backup.manifestDigest ||
        head.version !== committed.version ||
        head.capsuleDigest !== committed.capsuleDigest
      )
        throw new Error("Unconfirmed enrollment");
      enrollmentPending = false;
      reserveConfirmed = true;
      notice = {
        tone: "success",
        title: "Reserve prepared and independently checked.",
        text: "You can discard this session. Fresh recovery will discover the reserve without the primary app or this window’s state.",
      };
      render();
    }, true);
});
function exportCopy() {
  if (!recovered) return;
  const file = {
    format: "continuity-local-export/v1",
    localWorkingCopy: true,
    source: {
      owner: recovered.context.owner,
      streamId: recovered.context.streamId,
      version: recovered.version,
      digest: recovered.capsuleDigest,
      evidence: recovered.evidence,
    },
    content: workspace,
  };
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(file, null, 2)], { type: "application/json" }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "continuity-local-copy.json";
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  notice = {
    tone: "neutral",
    title: "A plaintext local copy was exported.",
    text: "The file contains your content. It carries the source receipt and does not create a new registry checkpoint.",
  };
  render();
}
if (isRecovery && query.get("enroll") === "1" && window.opener) {
  const opener = window.opener;
  channel = new HandoffChannel({
    role: "recovery",
    peer: opener,
    origin: policy.aOrigin,
    send: (data, origin) => opener.postMessage(data, origin),
  });
  enrollmentPending = true;
  watchEnrollment(channel, opener);
  const ready = setInterval(() => channel?.ready(), 400);
  setTimeout(() => clearInterval(ready), 300000);
}
window.addEventListener("pagehide", () => {
  primary?.close();
  channel?.close();
  offer?.dataKey.fill(0);
});
render();
void refreshStatus();
