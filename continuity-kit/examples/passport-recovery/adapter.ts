/** Experimental data-only adapter. Not Turnstile code or an identity integration. */
import {
  ContinuityError,
  record,
  string,
  validateWorkspace,
} from "../../src/sdk/index.ts";
import type { Workspace } from "../../src/sdk/index.ts";

export interface PassportData {
  v: 1;
  name: string;
  notes: Record<string, { text: string; at: number }>;
}

// Deliberately small supported subset for this example, not Turnstile's limits.
export const MAX_NOTES = 16;
export const MAX_DRAFT_BYTES = 8 * 1024;
const FORMAT = "continuity-passport-example/v1";
const SOURCE = "turnstile-private-passport";
const TITLE = "Public synthetic passport recovery example";
const PLAN = "Selected private content only; no ticket or account authority.";
const NOTE_KEY = /^[1-9][0-9]{0,15}:0x[0-9a-f]{40}:(?:0|[1-9][0-9]{0,15})$/;

function invalid(): never {
  throw new ContinuityError(
    "SCHEMA_INVALID",
    "Unsupported passport example payload",
  );
}

/** Strict and lossless for accepted input: never silently drop or truncate fields. */
export function validatePassport(
  value: unknown,
): asserts value is PassportData {
  const p = record(value, ["v", "name", "notes"]);
  if (p.v !== 1) invalid();
  string(p.name, 40);
  if (!p.notes || typeof p.notes !== "object" || Array.isArray(p.notes))
    invalid();
  const entries = Object.entries(p.notes);
  if (entries.length > MAX_NOTES) invalid();
  for (const [key, note] of entries) {
    if (!NOTE_KEY.test(key)) invalid();
    const n = record(note, ["text", "at"]);
    string(n.text, 280);
    if (!n.text.trim() || !Number.isSafeInteger(n.at) || (n.at as number) < 0)
      invalid();
  }
}

function orderedPassport(input: PassportData): PassportData {
  return {
    v: 1,
    name: input.name,
    notes: Object.fromEntries(
      Object.keys(input.notes)
        .sort()
        .map((key) => [
          key,
          { text: input.notes[key]!.text, at: input.notes[key]!.at },
        ]),
    ),
  };
}

function encodeDraft(value: unknown): string {
  validatePassport(value);
  const draft = JSON.stringify({
    format: FORMAT,
    sourceApplication: SOURCE,
    passport: orderedPassport(value),
  });
  if (new TextEncoder().encode(draft).length > MAX_DRAFT_BYTES) invalid();
  return draft;
}

export function toCheckpoint(value: unknown): Workspace {
  const workspace = {
    title: TITLE,
    plan: PLAN,
    tasks: [],
    draft: encodeDraft(value),
  };
  validateWorkspace(workspace);
  return workspace;
}

/** Call only on SDK-verified current content; this function does not verify a registry. */
export function fromCheckpoint(value: unknown): PassportData {
  validateWorkspace(value);
  if (value.title !== TITLE || value.plan !== PLAN || value.tasks.length !== 0)
    invalid();
  if (new TextEncoder().encode(value.draft).length > MAX_DRAFT_BYTES) invalid();
  let parsed: unknown;
  try {
    parsed = JSON.parse(value.draft);
  } catch {
    return invalid();
  }
  const envelope = record(parsed, ["format", "sourceApplication", "passport"]);
  if (envelope.format !== FORMAT || envelope.sourceApplication !== SOURCE)
    invalid();
  validatePassport(envelope.passport);
  // Enforce our exact encoding too: rejects duplicate keys/noncanonical wrappers.
  if (encodeDraft(envelope.passport) !== value.draft) invalid();
  return orderedPassport(envelope.passport);
}

/** Memory-only trigger policy. Not a freshness assertion about a previously saved copy. */
export function hasMeaningfulChange(before: unknown, after: unknown): boolean {
  validatePassport(before);
  validatePassport(after);
  if (before.name.trim() !== after.name.trim()) return true;
  const first = Object.keys(before.notes).sort();
  const second = Object.keys(after.notes).sort();
  return (
    first.length !== second.length ||
    first.some(
      (key, i) =>
        key !== second[i] ||
        before.notes[key]!.text.trim() !== after.notes[key]!.text.trim(),
    )
  );
}
