/** Byte persistence only. Recovery authority remains in the SDK and registry. */
export type ObjectKind = "index" | "blob";
export interface DemoObjectStore {
  read(slot: number, kind: ObjectKind, key: string): Promise<Uint8Array | null>;
  putImmutable(
    slot: number,
    kind: ObjectKind,
    key: string,
    bytes: Uint8Array,
  ): Promise<"stored" | "conflict" | "unavailable">;
}
