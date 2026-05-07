import {
  OFFSCREEN_PORT_NAME,
  PortMessageSchema,
  type PortBroadcast,
  type PortRequest,
  type PortResponse,
} from "./port-envelope";

type BroadcastHandler = (payload: unknown) => void;

export interface PortClientOptions {
  /** If true, skip the ensure-offscreen ping (caller guarantees offscreen is alive). */
  skipEnsureOffscreen?: boolean;
}

export class PortClient {
  private port: chrome.runtime.Port | null = null;
  private connecting: Promise<void> | null = null;
  private pending = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private subscriptions = new Map<PortBroadcast["event"], Set<BroadcastHandler>>();

  constructor(private options: PortClientOptions = {}) {}

  /**
   * Kicks off connection. Safe to fire-and-forget; `call()` awaits internally
   * if the port isn't ready yet.
   */
  connect(): Promise<void> {
    if (this.port) return Promise.resolve();
    if (this.connecting) return this.connecting;
    this.connecting = this.doConnect().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async doConnect(): Promise<void> {
    if (!this.options.skipEnsureOffscreen) {
      // Ask the SW to spawn the offscreen doc first; without this the port
      // opens before any listener exists and immediately disconnects.
      const reply = (await chrome.runtime.sendMessage({
        type: "ensure-offscreen",
      })) as { ok: boolean; error?: string } | undefined;
      if (!reply?.ok) {
        throw new Error(reply?.error ?? "Failed to ensure offscreen document");
      }
    }
    this.port = chrome.runtime.connect({ name: OFFSCREEN_PORT_NAME });
    this.port.onMessage.addListener((raw) => this.onMessage(raw));
    this.port.onDisconnect.addListener(() => this.onDisconnect());
  }

  disconnect() {
    this.port?.disconnect();
    this.port = null;
  }

  async call<T>(method: string, args: unknown[]): Promise<T> {
    if (!this.port) await this.connect();
    if (!this.port) throw new Error("Port not connected");
    const id = crypto.randomUUID();
    const req: PortRequest = { kind: "request", id, method, args };
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.port!.postMessage(req);
    });
  }

  onBroadcast(event: PortBroadcast["event"], handler: BroadcastHandler): () => void {
    let set = this.subscriptions.get(event);
    if (!set) {
      set = new Set();
      this.subscriptions.set(event, set);
    }
    set.add(handler);
    return () => set!.delete(handler);
  }

  private onMessage(raw: unknown) {
    const parsed = PortMessageSchema.safeParse(raw);
    if (!parsed.success) return;
    const msg = parsed.data;
    if (msg.kind === "response") {
      this.onResponse(msg);
    } else if (msg.kind === "broadcast") {
      this.onBroadcastReceived(msg);
    }
  }

  private onResponse(msg: PortResponse) {
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    this.pending.delete(msg.id);
    if (msg.ok) {
      // Fallback path on the server side stringified the result (when
      // structured clone couldn't handle it). Parse it back here so the
      // caller still gets a normal value.
      const result =
        msg.resultIsJson && typeof msg.result === "string"
          ? JSON.parse(msg.result)
          : msg.result;
      pending.resolve(result);
    } else {
      pending.reject(new Error(msg.error?.message ?? "Unknown error"));
    }
  }

  private onBroadcastReceived(msg: PortBroadcast) {
    const set = this.subscriptions.get(msg.event);
    if (!set) return;
    for (const handler of set) handler(msg.payload);
  }

  private onDisconnect() {
    const err = new Error("Port disconnected");
    for (const { reject } of this.pending.values()) reject(err);
    this.pending.clear();
    this.port = null;
  }
}
