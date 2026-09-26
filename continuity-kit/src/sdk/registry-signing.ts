import { canonical } from "./crypto.ts";
import { CONTEXT_FIELDS, hex32, record, uint } from "./policy.ts";
import { ContinuityError } from "./types.ts";
import type { FixedContext, RegistryCommand } from "./types.ts";
/** Exact local-model authorization domain. This is not a chain transaction. */
export function registryDomain(context: FixedContext): FixedContext {
  const domain = {} as FixedContext;
  for (const field of CONTEXT_FIELDS) {
    if (field === "owner" || field === "streamId") continue;
    (domain as unknown as Record<string, unknown>)[field] = context[field];
  }
  return Object.freeze(domain);
}
export function validateRegistryCommand(command: RegistryCommand): void {
  if (command.operation !== "create" && command.operation !== "commit")
    throw new ContinuityError(
      "CONTEXT_MISMATCH",
      "Unsupported registry operation",
    );
  if (!/^0x[0-9a-f]{40}$/.test(command.owner) || /^0x0+$/.test(command.owner))
    throw new ContinuityError("CONTEXT_MISMATCH", "Invalid owner");
  hex32(command.streamId);
  if (command.operation === "create") {
    record(command, [
      "operation",
      "owner",
      "streamId",
      "manifestDigest",
      "initialCapsuleDigest",
    ]);
    hex32(command.manifestDigest);
    hex32(command.initialCapsuleDigest);
  } else {
    record(command, [
      "operation",
      "owner",
      "streamId",
      "expectedVersion",
      "expectedDigest",
      "nextDigest",
    ]);
    uint(command.expectedVersion);
    hex32(command.expectedDigest);
    hex32(command.nextDigest);
  }
}
export function registrySigningMessage(
  context: FixedContext,
  command: RegistryCommand,
): string {
  validateRegistryCommand(command);
  return canonical({ domain: registryDomain(context), ...command });
}
