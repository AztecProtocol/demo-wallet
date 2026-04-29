import {
  OFFSCREEN_PORT_NAME,
  PortMessageSchema,
  type PortBroadcast,
  type PortRequest,
  type PortResponse,
} from "./port-envelope";

type BroadcastHandler = (payload: unknown) => void;

export class PortClient {
  private port: chrome.runtime.Port | null = null;
  private pending = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private subscriptions = new Map<PortBroadcast["event"], Set<BroadcastHandler>>();

  connect() {
    this.port = chrome.runtime.connect({ name: OFFSCREEN_PORT_NAME });
    this.port.onMessage.addListener((raw) => this.onMessage(raw));
    this.port.onDisconnect.addListener(() => this.onDisconnect());
  }

  disconnect() {
    this.port?.disconnect();
    this.port = null;
  }

  async call<T>(method: string, args: unknown[]): Promise<T> {
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
      pending.resolve(msg.result);
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
