const protocol = "continuity-handoff/v2";
const noncePattern = /^[a-f0-9]{64}$/;
const randomNonce = () =>
  [...crypto.getRandomValues(new Uint8Array(32))]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
type Message = {
  protocol: string;
  kind: string;
  step: number;
  aNonce?: string;
  bNonce: string;
  payload?: unknown;
};
type HandoffEvent = { origin: string; source: unknown; data: unknown };
export type Delivery = {
  kind: "offer" | "begin" | "grant" | "backup" | "committed";
  payload: unknown;
};

/** Exact peer/origin binding, expiring nonces and one-way steps. No wildcard target origins. */
export class HandoffChannel {
  private phase = 0;
  private readonly startedAt: number;
  private readonly ownNonce: string;
  private aNonce = "";
  private bNonce = "";
  private readonly role: "primary" | "recovery";
  private readonly peer: unknown;
  private readonly origin: string;
  private readonly send: (data: Message, origin: string) => void;
  private readonly now: () => number;
  private offerPayload: unknown;
  constructor(options: {
    role: "primary" | "recovery";
    peer: unknown;
    origin: string;
    send: (data: Message, origin: string) => void;
    now?: () => number;
    nonce?: () => string;
  }) {
    this.role = options.role;
    this.peer = options.peer;
    this.origin = options.origin;
    this.send = options.send;
    this.now = options.now ?? Date.now;
    this.startedAt = this.now();
    this.ownNonce = (options.nonce ?? randomNonce)();
    if (
      !this.peer ||
      new URL(this.origin).origin !== this.origin ||
      !noncePattern.test(this.ownNonce)
    )
      throw new Error("Invalid handoff configuration");
    if (this.role === "primary") this.aNonce = this.ownNonce;
    else this.bNonce = this.ownNonce;
  }
  private active() {
    return (
      this.phase < 6 &&
      this.now() - this.startedAt < 300000 &&
      this.now() >= this.startedAt
    );
  }
  setOffer(payload: unknown) {
    if (!this.active() || this.role !== "primary" || this.phase !== 0)
      throw new Error("Unexpected offer");
    this.offerPayload = payload;
  }
  ready() {
    if (this.role === "recovery" && this.phase === 0 && this.active())
      this.send(
        { protocol, kind: "ready", step: 0, bNonce: this.bNonce },
        this.origin,
      );
  }
  accept(event: HandoffEvent): Delivery | null {
    if (
      !this.active() ||
      event.origin !== this.origin ||
      event.source !== this.peer ||
      !event.data ||
      typeof event.data !== "object"
    )
      return null;
    const m = event.data as Partial<Message>;
    if (
      m.protocol !== protocol ||
      typeof m.bNonce !== "string" ||
      !noncePattern.test(m.bNonce) ||
      Object.keys(m).some(
        (k) =>
          !["protocol", "kind", "step", "aNonce", "bNonce", "payload"].includes(
            k,
          ),
      )
    )
      return null;
    if (
      this.role === "primary" &&
      this.phase === 0 &&
      m.kind === "ready" &&
      m.step === 0 &&
      this.offerPayload !== undefined &&
      m.aNonce === undefined
    ) {
      this.bNonce = m.bNonce;
      this.phase = 1;
      this.send(
        {
          protocol,
          kind: "offer",
          step: 1,
          aNonce: this.aNonce,
          bNonce: this.bNonce,
          payload: this.offerPayload,
        },
        this.origin,
      );
      this.offerPayload = undefined;
      return null;
    }
    if (
      this.role === "recovery" &&
      this.phase === 0 &&
      m.kind === "offer" &&
      m.step === 1 &&
      m.bNonce === this.bNonce &&
      typeof m.aNonce === "string" &&
      noncePattern.test(m.aNonce)
    ) {
      this.aNonce = m.aNonce;
      this.phase = 1;
      return { kind: "offer", payload: m.payload };
    }
    if (m.aNonce !== this.aNonce || m.bNonce !== this.bNonce) return null;
    if (
      this.role === "primary" &&
      this.phase === 1 &&
      m.kind === "begin" &&
      m.step === 2 &&
      m.payload === undefined
    ) {
      this.phase = 2;
      return { kind: "begin", payload: undefined };
    }
    if (
      this.role === "recovery" &&
      this.phase === 2 &&
      m.kind === "grant" &&
      m.step === 3
    ) {
      this.phase = 3;
      return { kind: "grant", payload: m.payload };
    }
    if (
      this.role === "primary" &&
      this.phase === 3 &&
      m.kind === "backup" &&
      m.step === 4
    ) {
      this.phase = 4;
      return { kind: "backup", payload: m.payload };
    }
    if (
      this.role === "recovery" &&
      this.phase === 4 &&
      m.kind === "committed" &&
      m.step === 5
    ) {
      this.phase = 6;
      return { kind: "committed", payload: m.payload };
    }
    return null;
  }
  get isActive() {
    return this.active();
  }
  begin() {
    if (!this.active() || this.role !== "recovery" || this.phase !== 1)
      throw new Error("Handoff expired or out of order");
    this.phase = 2;
    this.send(
      {
        protocol,
        kind: "begin",
        step: 2,
        aNonce: this.aNonce,
        bNonce: this.bNonce,
      },
      this.origin,
    );
  }
  grant(payload: unknown) {
    if (!this.active() || this.role !== "primary" || this.phase !== 2)
      throw new Error("Handoff expired or out of order");
    this.phase = 3;
    this.send(
      {
        protocol,
        kind: "grant",
        step: 3,
        aNonce: this.aNonce,
        bNonce: this.bNonce,
        payload,
      },
      this.origin,
    );
  }
  backup(payload: unknown) {
    if (!this.active() || this.role !== "recovery" || this.phase !== 3)
      throw new Error("Handoff expired or out of order");
    this.phase = 4;
    this.send(
      {
        protocol,
        kind: "backup",
        step: 4,
        aNonce: this.aNonce,
        bNonce: this.bNonce,
        payload,
      },
      this.origin,
    );
  }
  committed(payload: unknown) {
    if (!this.active() || this.role !== "primary" || this.phase !== 4)
      throw new Error("Handoff expired or out of order");
    this.send(
      {
        protocol,
        kind: "committed",
        step: 5,
        aNonce: this.aNonce,
        bNonce: this.bNonce,
        payload,
      },
      this.origin,
    );
    this.close();
  }
  close() {
    this.phase = 6;
    this.offerPayload = undefined;
    this.aNonce = "";
    this.bNonce = "";
  }
}
