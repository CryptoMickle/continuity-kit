import "./style.css";
import { metadataFingerprint, validateContext } from "./sdk/policy.ts";
import { createRuntime } from "./runtime.ts";
import { createReleaseRuntime } from "./release/runtime.ts";
import { MeraPasskeyAdapter } from "./sdk/passkeys.ts";
import { SyntheticWebAuthnClient } from "./sdk/demo-fixture.ts";
import { createPrimary } from "./sdk/account.ts";
import type { PrimaryAccount, PrimaryState } from "./sdk/account.ts";
import { SetupDraft } from "./sdk/setup-draft.ts";
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
declare const __CONTINUITY_RELEASE_PROFILE__: unknown;
const release = typeof __CONTINUITY_RELEASE_PROFILE__ !== "undefined";
let uploadToken = ""; // Presenter capability, memory only; never sent to B or stored.
const runtime = release
  ? createReleaseRuntime(__CONTINUITY_RELEASE_PROFILE__, () => uploadToken)
  : createRuntime(
      typeof __CONTINUITY_TESTNET_CONFIG__ === "undefined"
        ? undefined
        : __CONTINUITY_TESTNET_CONFIG__,
    );
const policy = runtime.policy;
const chainRun = runtime.kind === "monad-testnet";
const uploadsUnlocked = () =>
  !release ||
  (/^[a-f0-9]{64}$/.test(uploadToken) &&
    "profile" in runtime &&
    Date.now() < Date.parse(runtime.profile.expiresAt));
const adapters = runtime.adapters;
const isRecovery = location.origin === policy.bOrigin;
const validOrigin = isRecovery || location.origin === policy.aOrigin;
const query = new URLSearchParams(location.search);
const recoveryEnrollment = isRecovery && query.get("enroll") === "1";
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
let offer: { context: Context } | null = null;
let grant: { context: Context; dataKey: Uint8Array } | null = null;
let grantWaiter: { resolve: () => void; reject: (e: Error) => void } | null =
  null;
let backupAttempted = false;
let setupDraft: SetupDraft | null = null;
let pageEnded = false;
let channel: HandoffChannel | null = null;
let busy = false;
let enrollmentPending = false;
let enrollmentAborted = false;
let enrollmentStartedAt: number | null = null;
let reserveConfirmed = false;
let toolsOpen = false;
let actionTail = Promise.resolve();
let primaryOnline = true;
let scenario = "healthy";
let localEdited = false;
const initialNotice = {
  tone: "neutral",
  title: isRecovery
    ? "Recovery has not been checked yet."
    : "A small workspace. A durable way back.",
  text: isRecovery
    ? "Use a recovery passkey only after completing reserve setup in the primary app. This screen does not confirm that a reserve exists."
    : "Prepare a reserve before your first protected checkpoint.",
};
let notice = initialNotice;
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
// Consistent decorative UI icons; actual state is always conveyed in text.
const uiIcon = (kind: "workspace" | "recovery" | "lock" | "document") => {
  const paths = {
    workspace:
      '<rect x="4" y="3" width="16" height="18" rx="3"/><path d="M8 8h8M8 12h8M8 16h5"/>',
    recovery:
      '<path d="M4 11a8 8 0 1 1 2.4 6M4 5v6h6"/><path d="M12 8v5l3 2"/>',
    lock: '<rect x="5" y="10" width="14" height="11" rx="3"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/>',
    document:
      '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h5"/>',
  };
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[kind]}</svg>`;
};
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
  if (pageEnded || (busy && !required)) return;
  const previous = actionTail;
  let finish!: () => void;
  actionTail = new Promise<void>((resolve) => {
    finish = resolve;
  });
  await previous;
  if (pageEnded) {
    finish();
    return;
  }
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
  if (release) throw new Error("Public demonstration controls are unavailable");
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
  if (release) return;
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
function editStateText() {
  if (pendingTicket) return "Transaction confirmation pending";
  if (localEdited)
    return isRecovery
      ? "Local working copy · source receipt unchanged"
      : "Unsaved local changes";
  return recovered
    ? `Verified checkpoint v${recovered.version}`
    : state
      ? "Open the saved checkpoint before saving changes"
      : "Sample content · held in this window";
}
// Compare exact workspace content, not fresh encryption bytes. This is a local
// change check against an accepted snapshot, not a fresh registry read.
function hasCheckpointChanges() {
  return (
    recovered !== null &&
    metadataFingerprint(workspace) !== metadataFingerprint(recovered.content)
  );
}
function canSaveCheckpoint() {
  return (
    !!state &&
    !busy &&
    !pendingTicket &&
    uploadsUnlocked() &&
    hasCheckpointChanges()
  );
}
function saveButtonText() {
  return state && recovered && !pendingTicket && !hasCheckpointChanges()
    ? "No unsaved changes"
    : "Save checkpoint";
}
function editorMarkup() {
  const action = isRecovery
    ? '<button class="button dark" id="export">Export local copy ↗</button>'
    : `<button class="button dark" id="save" ${canSaveCheckpoint() ? "" : "disabled"}>${saveButtonText()}</button>`;
  return `<div class="document-head"><div class="document-identity"><span>${uiIcon("document")}</span><strong>${isRecovery ? "Recovered copy" : state ? "Working copy" : "Sample workspace"}</strong></div>${action}</div>
    <div class="document-status"><span id="edit-state">${escape(editStateText())}</span>${!state && !isRecovery ? '<span class="sample-label">EXAMPLE CONTENT</span>' : ""}</div>
    <div class="document-body"><label class="field title-field">Workspace title<input id="title" maxlength="200" value="${escape(workspace.title)}" ${busy || enrollmentPending ? "disabled" : ""}></label>
    <label class="field">The plan<textarea id="plan" rows="2" maxlength="16000" ${busy || enrollmentPending ? "disabled" : ""}>${escape(workspace.plan)}</textarea></label>
    <div class="task-section"><span class="field-label">Next steps</span><div class="tasks">${workspace.tasks.map((task, i) => `<label class="task"><input type="checkbox" data-task="${i}" ${busy || enrollmentPending ? "disabled" : ""} ${task.done ? "checked" : ""}><span>${escape(task.text)}</span></label>`).join("")}</div></div>
    <label class="field draft-field">Working draft<textarea id="draft" rows="7" maxlength="64000" ${busy || enrollmentPending ? "disabled" : ""}>${escape(workspace.draft)}</textarea></label></div>
    <div class="document-footer">${uiIcon("lock")}<span>${isRecovery ? "Edits affect this local copy. Export to keep them." : "Changes stay in this tab until you save a checkpoint."}</span></div>`;
}
function primaryStatusMarkup() {
  const rows = [
    [
      "Workspace",
      state
        ? "Open in this session"
        : primary
          ? "Primary key ready"
          : "Not opened",
      !!state,
    ],
    [
      "Encrypted reserve",
      state
        ? "Prepared"
        : enrollmentPending
          ? "Setup in progress"
          : "Not checked",
      !!state,
    ],
    [
      "Checkpoint",
      pendingTicket
        ? "Confirmation pending"
        : recovered
          ? `Version ${recovered.version} verified`
          : "Not checked",
      !!recovered && !pendingTicket,
    ],
  ] as const;
  return `<ol class="protection-steps">${rows.map(([name, detail, complete], i) => `<li data-complete="${complete}"><span class="step-marker" aria-hidden="true">${complete ? "✓" : String(i + 1).padStart(2, "0")}</span><div><strong>${name}</strong><span>${escape(detail)}</span></div></li>`).join("")}</ol><p class="inspector-note">${state ? "Your reserve is prepared. Open the recovery client with its separate key when you need your saved work." : "A reserve must be prepared before it can recover your work. Opening a workspace checks its existing setup."}</p>`;
}
function proofMarkup() {
  if (!recovered)
    return '<div class="empty-proof"><span class="empty-state-label">NOT CHECKED</span><p>No recovery verified in this session.</p><small>Open your saved work to see its version and verification details here.</small></div>';
  return `<div class="verified-label">✓ ${recovered.evidence.trustMode === "local-model" ? "VERIFIED IN LOCAL MODEL" : "VERIFIED THROUGH FINALIZED RPC QUORUM"}</div><div class="version-number"><span>Verified checkpoint</span><strong>v${escape(recovered.version)}</strong><small>Current at the accepted read</small></div><dl><dt>Owner</dt><dd title="${escape(recovered.context.owner)}">${short(recovered.context.owner)}</dd><dt>Checkpoint</dt><dd title="${escape(recovered.capsuleDigest)}">${short(recovered.capsuleDigest)}</dd><dt>${recovered.evidence.trustMode === "local-model" ? "Model" : "Finalized"} block</dt><dd>${escape(recovered.evidence.blockNumber)}</dd><dt>Checked</dt><dd>${new Date(recovered.evidence.observedAt).toLocaleTimeString()}</dd></dl>${recovered.diagnostics.length ? `<div class="mirror-warning">${recovered.diagnostics.length} invalid or unavailable mirror response(s) rejected. A valid copy passed all checks.</div>` : '<p class="proof-footnote">The exact stored bytes match the owner-approved digest.</p>'}<details><summary>Inspect verification receipt</summary><pre>${escape(JSON.stringify({ ...recovered, content: undefined, writeProof }, null, 2))}</pre></details>`;
}
function setupTimeText() {
  if (enrollmentStartedAt === null) return "";
  const connecting = isRecovery && !offer && !backup;
  const duration = connecting ? 15000 : 300000;
  const seconds = Math.max(
    0,
    Math.ceil((enrollmentStartedAt + duration - Date.now()) / 1000),
  );
  const time = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  return `${connecting ? "Waiting for setup request" : "Setup time remaining"}: ${time}. Keep both windows open; do not reload during setup.`;
}
function guideActionsMarkup() {
  if (!isRecovery) {
    const restore = `<button class="button ${primary ? "outline" : "dark"}" id="restore" ${busy || pendingTicket || enrollmentPending || (!!primary && !state) ? "disabled" : ""}>Open existing workspace ↗</button>`;
    if (pendingTicket)
      return `<div class="guide-actions"><button class="button dark" id="check-transaction" ${busy ? "disabled" : ""}>Check transaction status</button><button class="text-button" id="export-ticket" ${busy ? "disabled" : ""}>Export transaction reference</button></div><details class="guide-details"><summary>Other workspace actions</summary>${restore}<p>Opening a workspace is unavailable until this transaction is resolved.</p></details>`;
    if (state && !recovered)
      return `<div class="guide-actions">${restore}</div><p>Opening the saved version replaces this draft. Keep a copy of any unsaved text first.</p>`;
    if (state)
      return `<div class="guide-actions"><a class="text-button" href="#workspace">Go to workspace ↓</a></div><details class="guide-details"><summary>Reopen the saved workspace</summary><p>Opening the saved version replaces the draft in this window. Keep a copy of any unsaved text first.</p>${restore}</details>`;
    const prepare = `<button class="button ${primary ? "dark" : "outline"}" id="prepare" ${busy || !uploadsUnlocked() || enrollmentPending || (enrollmentAborted && !setupDraft?.paused) || pageEnded ? "disabled" : ""}>${setupDraft?.paused ? "Continue setup with passkey" : enrollmentAborted ? "Setup ended" : primary ? "Open recovery setup" : physical ? "Create primary passkey" : "Create demo account"}</button>`;
    return `<div class="guide-actions">${primary ? prepare : restore + prepare}${setupDraft?.resumable && !setupDraft.paused && !busy ? '<button class="text-button" id="pause-setup">Pause setup</button>' : ""}${primary ? restore : ""}</div>`;
  }
  if (recovered)
    return '<div class="guide-actions"><a class="text-button" href="#workspace">Read or export your work ↓</a></div>';
  if (recoveryEnrollment && !offer && !reserveConfirmed) return "";
  if (offer && backupAttempted) return "";
  return `<div class="guide-actions"><button class="button dark" id="${offer ? "enroll" : "recover"}" ${busy ? "disabled" : ""}>${offer ? (physical ? "Create recovery passkey" : "Prepare simulated reserve") : physical ? "Recover with passkey" : "Recover demo workspace"} ↗</button></div>`;
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
  } else if (pendingTicket) {
    label = "WAITING FOR CONFIRMATION";
    title = "Check the existing transaction.";
    text =
      "Check its status here. This only reads the result; it does not sign or send another transaction. Keep this tab open until confirmation finishes.";
  } else if (setupDraft?.paused) {
    label = "SETUP PAUSED";
    title = "Continue with the same primary key.";
    text =
      "This tab retains an encrypted setup draft. Continue setup with passkey reopens the same account and reserve plan. Keep this primary tab open; closing or reloading it loses the unfinished setup.";
  } else if (notice.tone === "error") {
    label = "ACTION NEEDS ATTENTION";
    title = "The last action needs attention.";
    text =
      "Read the error message below. Keep your existing passkeys; creating a new key will not recover missing work.";
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
    text = `Save a new key for ${b}. It is separate from your ${a} key. Wait for “Reserve prepared and independently checked”.`;
  } else if (enrollmentPending && isRecovery && !offer && !backup) {
    label = "CONNECTING";
    title = "Waiting for the primary app.";
    text =
      "No passkey action is available until the primary app sends its setup request. This connection check stops after 15 seconds.";
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
    title = physical
      ? "Use your reserve app’s passkey."
      : "Open your prepared demo reserve.";
    text = physical
      ? `Use the existing key for ${b}. If your device says no key is saved, check the device or password manager used during setup; do not create another key to recover this work.`
      : "Use the public test credential to open the saved demo workspace. The client checks its version before showing the content.";
  } else if (state && !recovered) {
    label = "OPEN THE CONFIRMED CHECKPOINT";
    title = "Check the saved version before continuing.";
    text =
      "The reserve is registered, but this draft has not been compared with its saved content. Open the existing workspace before saving another checkpoint.";
  } else if (state) {
    label = "RESERVE READY";
    title = "Workspace open.";
    text =
      "Use Save checkpoint to protect the latest changes. Unsaved edits are held only in this window.";
  } else if (primary) {
    label = "SETUP · STEP 2 OF 2";
    title = "Open the reserve app.";
    text = `Your original app key is ready. Choose Open recovery setup to prepare a separate key for ${b}. Your reserve is not ready yet. The reserve window expires after five minutes. Before recovery-key creation starts, an interruption pauses setup in this primary tab.`;
  } else {
    label = "START HERE";
    title = "Open your workspace.";
    text = physical
      ? `Use your existing ${a} key. For a new workspace, create a primary key and then a separate recovery key. Keep this tab open during setup. You can pause before recovery-key creation starts.`
      : "Use the existing demo account, or create a new one to try the two-step reserve setup.";
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
      " First fund the test account shown below using the approved free test-token process. Completing reserve setup submits its first testnet transaction.";
  if (!physical)
    text = text
      .replaceAll("Create primary passkey", "Create demo account")
      .replaceAll("Create recovery passkey", "Prepare simulated reserve")
      .replaceAll("Recover with passkey", "Recover demo workspace");
  const ready =
    (state || recovered) && !busy && !pendingTicket && notice.tone !== "error";
  return `<section class="step-guide" data-phase="${ready ? "ready" : pendingTicket ? "pending" : "setup"}" aria-label="Your next step"><div class="guide-copy"><span class="eyebrow">${escape(label)}</span><h2>${escape(title)}</h2><p>${escape(text)}</p></div><div class="guide-controls">${guideActionsMarkup()}</div>${enrollmentPending && !pendingTicket ? `<p id="setup-clock" role="timer">${escape(setupTimeText())}</p>` : ""}${physical && !enrollmentAborted && !recovered && !reserveConfirmed && !state ? '<small class="prompt-hint">Your device may ask for more than one confirmation. Finish any open prompt before starting another action.</small>' : ""}</section>`;
}
function recoveryStartMarkup() {
  // An enrollment URL must never silently become a recovery prompt. A bound
  // offer from this window's actual opener is required before creating B.
  if (recoveryEnrollment && !offer && !reserveConfirmed)
    return `<div class="recovery-empty"><span class="eyebrow">RESERVE SETUP</span><h2>${enrollmentAborted ? "Setup could not continue." : backup ? "Waiting for the first checkpoint." : "Connecting to the primary app."}</h2><p>${enrollmentAborted ? "No reserve was confirmed in this window. Keep any existing passkeys. Return to the primary app and check its setup status." : backup ? "Your recovery passkey is ready. Keep both windows open while the primary app finishes saving and the reserve checks the result." : "Keep both windows open. The option to create your recovery passkey appears after the apps establish their connection."}</p></div>`;
  if (offer && backupAttempted && !busy)
    return '<div class="recovery-empty"><h2>Setup needs review.</h2><p>Recovery-key creation was attempted. A cancelled or incomplete prompt may still have created a key. Keep existing keys; this setup will not create another.</p></div>';
  return `<div class="recovery-empty"><div class="empty-icon">${uiIcon("recovery")}</div><h2>${offer ? "Prepare a separate recovery key" : "Open work from your reserve"}</h2><p>${offer ? "The recovery key opens your encrypted copy. It does not receive your primary signing key." : "The recovery client checks the saved version before opening your content."}</p><dl class="recovery-explainer"><dt>Use</dt><dd>${physical ? "Your existing recovery passkey" : "The prepared demo credential"}</dd><dt>Get back</dt><dd>Your latest verified checkpoint</dd><dt>Continue with</dt><dd>A local copy you can edit and export</dd></dl></div>`;
}
function releaseAccessMarkup() {
  if (!release) return "";
  if (isRecovery)
    return `<section class="boundary-card"><h3>Limited demonstration · example data only</h3><p>Access to this demo ends at ${escape("profile" in runtime ? runtime.profile.expiresAt : "")}. Export any recovered example work you want to keep. This deadline does not erase stored copies.</p></section>`;
  return `<section class="boundary-card"><h3>Presenter demonstration · example data only</h3><p>${uploadsUnlocked() ? "Upload access is held in this tab only. The store checks it on each write." : "New setup and uploads require the presenter’s demo code. Existing recovery needs only its prepared passkey."}</p>${!uploadsUnlocked() ? '<label class="field">Demo upload code<input id="upload-code" type="password" autocomplete="off" maxlength="64" spellcheck="false"></label><button class="button outline" id="unlock-uploads">Use code for this session</button>' : ""}<p>This limited demo expires at ${escape("profile" in runtime ? runtime.profile.expiresAt : "")}.</p></section>`;
}
function render() {
  const tools = document.querySelector<HTMLDetailsElement>("#test-tools");
  if (tools) toolsOpen = tools.open;
  if (!validOrigin) {
    app.innerHTML = `<main><h1>Open the configured client</h1><p>This origin is not part of the recovery policy.</p><a href="${escape(policy.aOrigin)}">Open primary workspace</a></main>`;
    return;
  }
  app.innerHTML = `<div class="shell"><aside class="sidebar"><a class="brand" href="${policy.aOrigin}${modeQuery}"><span class="brand-mark" aria-hidden="true"><i></i><i></i><i></i></span>continuity<span>kit</span></a><div class="nav-label">WORKSPACE</div><nav aria-label="Workspace navigation"><a class="${!isRecovery ? "active" : ""}" ${!isRecovery ? 'aria-current="page"' : ""} href="${policy.aOrigin}${modeQuery}"><span class="nav-icon">${uiIcon("workspace")}</span> Primary workspace <small>A</small></a><a class="${isRecovery ? "active" : ""}" ${isRecovery ? 'aria-current="page"' : ""} href="${policy.bOrigin}${modeQuery}"><span class="nav-icon">${uiIcon("recovery")}</span> Recovery client <small>B</small></a></nav><div class="session-panel"><span class="nav-label">THIS SESSION</span><div class="session-workspace">${uiIcon("document")}<span>${state || recovered ? escape(workspace.title) : "No workspace open"}</span></div><p>${state || recovered ? "Workspace open in this session." : "Open your work to see its saved state."}</p></div><div class="sidebar-bottom"><span class="local-badge"><i></i> ${chainRun ? "Testnet preview" : "Local preview"}</span><p>${physical ? "Physical passkeys" : "Public test credentials"}<br>Experimental · v0.1</p></div></aside>
  <main><header class="topbar"><div class="breadcrumbs"><span>ContinuityKit</span><span>/</span><strong>${isRecovery ? "Recovery" : "Workspace"}</strong></div><div class="topbar-status"><span class="status-dot ${primaryOnline ? "" : "offline"}"></span>${release ? "Independent version check" : `Primary ${primaryOnline ? "available" : "offline"}`}<span class="mode-tag">${chainRun ? "MONAD TESTNET" : physical ? "PHYSICAL TEST" : "LOCAL SIMULATION"}</span></div></header>
  <div class="main-content"><section class="page-heading"><div><h1>${isRecovery ? "Recovery" : "Your workspace"}</h1><p>${isRecovery ? "Open and verify the copy you prepared in advance." : "Write, save a checkpoint, and keep a way back to your work."}</p></div><span class="origin-label">${isRecovery ? "INDEPENDENT CLIENT" : "PRIMARY CLIENT"}</span></section>
  ${releaseAccessMarkup()}
  ${guideMarkup()}
  ${notice !== initialNotice || busy ? `<div class="notice ${notice.tone}" role="status" aria-live="polite"><span>${busy ? "◌" : notice.tone === "error" ? "!" : notice.tone === "success" ? "✓" : "↳"}</span>${notice.tone === "success" && !busy ? `<details><summary><strong>${escape(notice.title)}</strong></summary><p>${escape(notice.text)}</p></details>` : `<div><strong>${escape(notice.title)}</strong><p>${escape(notice.text)}</p></div>`}</div>` : ""}
  ${chainRun ? `<section class="boundary-card"><h3>${release ? "Monad testnet · bounded demonstration" : "Monad testnet · separate setup"}</h3><p>${release ? "This demonstration uses Monad testnet and two encrypted copies under one operator. It is not a production backup service." : "This run uses real testnet transactions and two encrypted copies in one local service."} Existing local credentials and reserves remain bound to their original setup.</p><p>Registry: <code>${escape(policy.registryAddress)}</code></p>${!isRecovery && primary ? `<p>${enrollmentAborted || state ? "Test account" : "Test account to fund before reserve setup"}: <code>${escape(primary.context.owner)}</code></p>` : ""}</section>` : ""}
  <section class="content-grid"><article class="document" id="workspace" aria-label="${isRecovery ? "Recovered workspace" : "Workspace editor"}">${!isRecovery || recovered ? editorMarkup() : recoveryStartMarkup()}</article>
  <aside class="right-stack" aria-label="Workspace protection"><section class="reserve-card" id="protection"><div class="inspector-heading"><span>${uiIcon(isRecovery ? "recovery" : "lock")}</span><h2>${isRecovery ? "Verification" : "Reserve status"}</h2></div>${isRecovery ? proofMarkup() : primaryStatusMarkup()}</section>
  <section class="boundary-card"><h3>${isRecovery ? "About this copy" : "How recovery works"}</h3><p>${isRecovery ? "You can edit and export this copy. It cannot sign transactions or change the saved checkpoint." : "A separate key opens your encrypted reserve when the original app is unavailable."}</p><details><summary>Storage &amp; privacy</summary><p>${chainRun ? (release ? "Encrypted content stays in the demo store. Monad testnet receives a version and digest. Both copies share one operator and database." : "The stores receive encrypted content. Monad testnet receives the version and digest. Both stores still run in one local service.") : "The stores receive encrypted content. Version checks use a local registry in this demonstration. Both copies share one local service."}</p></details></section></aside></section>
  ${release ? "" : `<details class="test-tools" id="test-tools" ${toolsOpen ? "open" : ""}><summary>Demonstration tools · outages and verification tests</summary><section class="demo-controls"><div><span class="eyebrow">TRY THE FAILURE, TOO</span><h2>Recovery should earn your trust.</h2><p>Change the conditions. Then run recovery in a fresh client.</p></div><div class="controls"><label>Mirror / registry condition<select id="scenario" ${busy || enrollmentPending ? "disabled" : ""}><option value="healthy">Both copies healthy</option><option value="stale-one">Mirror 1 serves an old valid copy</option><option value="stale-both">Both mirrors serve an old valid copy</option><option value="missing-current">Latest bytes unavailable</option>${chainRun ? "" : '<option value="freshness-offline">Registry unavailable</option>'}<option value="corrupt-index">Reserve metadata corrupted</option></select></label><button class="button outline" id="outage" ${busy || enrollmentPending ? "disabled" : ""}>${primaryOnline ? "Take primary offline" : "Bring primary back"}</button><button class="text-button" id="fresh" ${busy || pendingTicket ? "disabled" : ""}>Discard this session & reload ↻</button>${isRecovery && recovered ? `<button class="button dark" id="recover-again" ${busy ? "disabled" : ""}>Check recovery again ↗</button>` : ""}</div></section></details>`}
  <footer><span>ContinuityKit / Experimental developer preview</span><span>${chainRun ? (release ? "Physical passkeys · Monad testnet 10143 · limited demonstration" : "Physical passkeys · Monad testnet 10143 · local encrypted stores") : (physical ? "Real authenticator · simulated registry" : "Simulated authenticator · simulated registry") + " · No Monad transactions"}</span></footer>
  </div></main></div>`;
  document.querySelector("#unlock-uploads")?.addEventListener("click", () => {
    const input = document.querySelector<HTMLInputElement>("#upload-code");
    if (!input) return;
    if (!/^[a-f0-9]{64}$/.test(input.value)) {
      notice = {
        tone: "error",
        title: "The demo code is incomplete or invalid.",
        text: "Copy the full presenter code and try again. No passkey was created.",
      };
      input.value = "";
      render();
      return;
    }
    const candidate = input.value;
    input.value = "";
    void run(async () => {
      if (!("profile" in runtime)) return;
      const response = await fetch(
        `${runtime.profile.storeOrigin}/v1/presenter-access`,
        {
          headers: { authorization: `Bearer ${candidate}` },
          cache: "no-store",
          redirect: "error",
          signal: AbortSignal.timeout(5000),
        },
      );
      if (pageEnded) return;
      if (response.status !== 204) {
        notice = {
          tone: "error",
          title: "Demo access was not accepted.",
          text: "Check the presenter code and demo availability before starting setup. No passkey was created.",
        };
        return;
      }
      uploadToken = candidate;
      notice = {
        tone: "neutral",
        title: "Presenter access checked.",
        text: "Use example content only. Setup uses real passkeys and Monad testnet.",
      };
    });
  });
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
        if (result.status === "saved") {
          recovered = result.recovered;
          // Confirmation must not overwrite edits made after the submitted save.
          localEdited =
            metadataFingerprint(workspace) !==
            metadataFingerprint(recovered.content);
        }
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
  document.querySelector("#pause-setup")?.addEventListener("click", pauseSetup);
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
        if (pendingTicket) return;
        primary?.close();
        const restored = await restorePrimary(policy, passkeys, adapters);
        if (pageEnded) {
          restored.state.close();
          return;
        }
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
        if (
          !state ||
          pendingTicket ||
          !uploadsUnlocked() ||
          !hasCheckpointChanges()
        )
          return;
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
    if (busy || pendingTicket) return;
    setupDraft?.close();
    primary?.close();
    channel?.close();
    grant?.dataKey.fill(0);
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
  localEdited =
    !recovered ||
    metadataFingerprint(workspace) !== metadataFingerprint(recovered.content);
  const el = document.querySelector("#edit-state");
  if (el) el.textContent = editStateText();
  const save = document.querySelector<HTMLButtonElement>("#save");
  if (save) {
    save.disabled = !canSaveCheckpoint();
    save.textContent = saveButtonText();
  }
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
function pauseSetup() {
  if (pageEnded || !setupDraft?.pause()) return;
  channel?.close();
  channel = null;
  enrollmentPending = false;
  enrollmentAborted = true;
  notice = {
    tone: "neutral",
    title: "Setup paused. Keep this primary tab open.",
    text: "Continue with your existing primary passkey when ready. Closing or reloading this tab loses this unfinished setup.",
  };
  render();
}
function watchIdleSetup() {
  const watched = primary;
  const timer = setInterval(() => {
    if (
      pageEnded ||
      primary !== watched ||
      !setupDraft?.resumable ||
      setupDraft.paused
    ) {
      clearInterval(timer);
      return;
    }
    if (watched && Date.now() >= watched.writer.expiresAt) {
      clearInterval(timer);
      pauseSetup();
    }
  }, 500);
}
function watchEnrollment(bound: HandoffChannel, peer: Window) {
  const started = Date.now();
  enrollmentStartedAt = started;
  const timer = setInterval(() => {
    if (channel !== bound || !enrollmentPending) {
      clearInterval(timer);
      return;
    }
    const elapsed = Date.now() - started;
    const connectionTimedOut =
      isRecovery && !offer && !backup && elapsed >= 15000;
    if (peer.closed || elapsed >= 300000 || connectionTimedOut) {
      clearInterval(timer);
      enrollmentPending = false;
      enrollmentAborted = true;
      channel = null;
      bound.close();
      grant?.dataKey.fill(0);
      grant = null;
      grantWaiter?.reject(new Error("Setup connection ended"));
      grantWaiter = null;
      offer = null;
      const paused = !isRecovery && !state && setupDraft?.pause();
      if (!state && !paused) primary?.close();
      notice = {
        tone: paused ? "neutral" : "error",
        title: paused
          ? "Setup paused. Keep this primary tab open."
          : peer.closed
            ? "The other enrollment window closed."
            : connectionTimedOut
              ? "No setup request arrived from the primary app."
              : "Reserve preparation expired.",
        text: paused
          ? "No recovery-key creation was granted. Continue with your existing primary passkey to reopen this same setup. Reloading or closing this tab loses the unfinished setup."
          : connectionTimedOut
            ? "The primary setup may have expired, or this window may have been reloaded. There is no recovery-passkey button to use. Check the primary app's status; keep existing passkeys."
            : "The setup window has closed and its passkey action is unavailable. Preparation has not been confirmed here. Keep existing passkeys and check the primary app before planning another setup.",
      };
      render();
      return;
    }
    const clock = document.querySelector("#setup-clock");
    if (clock) clock.textContent = setupTimeText();
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
  if (!uploadsUnlocked()) return;
  if (busy || enrollmentPending || pendingTicket || state || pageEnded) return;
  if (setupDraft?.paused) {
    void run(async () => {
      primary = await setupDraft!.resume(policy, passkeys, adapters);
      enrollmentAborted = false;
      notice = {
        tone: "success",
        title: "Same setup reopened. No new key was created.",
        text: "Choose Open recovery setup when ready. Keep this primary tab open until setup finishes.",
      };
      watchIdleSetup();
    });
    return;
  }
  if (enrollmentAborted) return;
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
      if (pageEnded) {
        primary.close();
        return;
      }
      try {
        setupDraft = await SetupDraft.create(primary, adapters);
      } catch (error) {
        primary.close();
        enrollmentAborted = true;
        throw error;
      }
      if (pageEnded) {
        setupDraft.close();
        return;
      }
      watchIdleSetup();
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
    // A named window may retain an old opener. Each handoff needs its own peer.
    "_blank",
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
  if (!offer || !channel || backupAttempted || pageEnded)
    throw new Error("No unused bound enrollment");
  const bound = channel;
  backupAttempted = true;
  validateContext(offer.context, policy);
  try {
    await new Promise<void>((resolve, reject) => {
      grantWaiter = { resolve, reject };
      bound.begin();
    });
    if (channel !== bound || !bound.isActive || !grant || pageEnded)
      throw new Error("Setup grant expired");
    const granted = grant;
    const prepared = await prepareBackup(
      policy,
      passkeys,
      granted,
      () => channel === bound && bound.isActive && !pageEnded,
    );
    if (channel !== bound || !bound.isActive || pageEnded)
      throw new Error("Setup ended during authentication");
    backup = prepared;
    offer = null;
    bound.backup(backup);
  } finally {
    grant?.dataKey.fill(0);
    grant = null;
    grantWaiter = null;
  }
  notice = {
    tone: "neutral",
    title: "Reserve wrapped. Waiting for the primary commit.",
    text: "Preparation is incomplete until the encrypted copies and version registry are verified.",
  };
}
window.addEventListener("message", (event) => {
  if (pageEnded) return;
  const delivery = channel?.accept(event);
  if (!delivery) return;
  if (delivery.kind === "offer" && isRecovery) {
    try {
      const received = delivery.payload as { context: Context };
      validateContext(received.context, policy);
      if (Object.keys(received).length !== 1)
        throw new Error("Invalid setup offer");
      offer = { context: received.context };
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
  if (delivery.kind === "begin" && !isRecovery) {
    try {
      if (!primary || !setupDraft || !channel)
        throw new Error("No primary setup");
      // Fence before key release: a lost grant or cancelled native ceremony cannot reset it.
      setupDraft.beginBackup(primary);
      channel.grant({
        context: primary.context,
        dataKey: new Uint8Array(primary.dataKey),
      });
      render();
    } catch (error) {
      channel?.close();
      channel = null;
      enrollmentPending = false;
      enrollmentAborted = true;
      if (!setupDraft?.pause()) primary?.close();
      fail(error);
      render();
    }
  }
  if (delivery.kind === "grant" && isRecovery) {
    try {
      const received = delivery.payload as {
        context: Context;
        dataKey: Uint8Array;
      };
      validateContext(received.context, policy);
      if (
        !offer ||
        !grantWaiter ||
        JSON.stringify(received.context) !== JSON.stringify(offer.context) ||
        !(received.dataKey instanceof Uint8Array) ||
        received.dataKey.length !== 32
      )
        throw new Error("Invalid creation grant");
      grant = {
        context: received.context,
        dataKey: new Uint8Array(received.dataKey),
      };
      grantWaiter.resolve();
      grantWaiter = null;
    } catch (error) {
      grantWaiter?.reject(error as Error);
      grantWaiter = null;
      channel?.close();
      channel = null;
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
      if (recovered) localEdited = false;
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
              : "Your first checkpoint is protected. Edit the workspace and save your changes when ready.",
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
if (recoveryEnrollment) {
  const opener = window.opener;
  if (!opener || opener.closed) {
    enrollmentAborted = true;
    notice = {
      tone: "error",
      title: "This setup window has no active primary connection.",
      text: "Open reserve setup from the primary app's setup button. A copied link or an old window cannot complete enrollment.",
    };
  } else {
    channel = new HandoffChannel({
      role: "recovery",
      peer: opener,
      origin: policy.aOrigin,
      send: (data, origin) => opener.postMessage(data, origin),
    });
    enrollmentPending = true;
    notice = {
      tone: "neutral",
      title: "Connecting to the primary app.",
      text: "No passkey is needed yet. Keep both windows open until the setup request arrives.",
    };
    watchEnrollment(channel, opener);
    const bound = channel;
    const ready = setInterval(() => {
      if (channel !== bound || !enrollmentPending || offer || backup)
        clearInterval(ready);
      else bound.ready();
    }, 400);
    setTimeout(() => clearInterval(ready), 300000);
  }
}
window.addEventListener("pagehide", () => {
  pageEnded = true;
  uploadToken = "";
  setupDraft?.close();
  primary?.close();
  channel?.close();
  channel = null;
  grant?.dataKey.fill(0);
  grant = null;
  offer = null;
  grantWaiter?.reject(new Error("Page ended"));
  grantWaiter = null;
  enrollmentPending = false;
  enrollmentAborted = true;
});
window.addEventListener("pageshow", () => {
  if (!pageEnded) return;
  notice = {
    tone: "error",
    title: "This page session has ended.",
    text: "Returning to an old page cannot reopen its unfinished setup. Keep existing keys. Completed work can be opened in a fresh session.",
  };
  render();
});
render();
void refreshStatus();
