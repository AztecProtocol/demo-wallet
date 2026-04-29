import {
  OFFSCREEN_PORT_NAME,
  PortMessageSchema,
  type PortBroadcast,
  type PortRequest,
  type PortResponse,
} from "./port-envelope";

export interface MethodHandlerMap {
  [methodName: string]: (...args: unknown[]) => Promise<unknown>;
}

export class PortServer {
  private ports = new Set<chrome.runtime.Port>();

  constructor(private handlers: MethodHandlerMap) {}

  start() {
    chrome.runtime.onConnect.addListener((port) => {
      if (port.name !== OFFSCREEN_PORT_NAME) return;
      this.ports.add(port);
      port.onMessage.addListener((raw) => this.onMessage(port, raw));
      port.onDisconnect.addListener(() => this.ports.delete(port));
    });
  }

  broadcast(event: PortBroadcast["event"], payload: unknown) {
    const msg: PortBroadcast = { kind: "broadcast", event, payload };
    for (const port of this.ports) {
      try {
        port.postMessage(msg);
      } catch {
        // port disconnected; will be cleaned up by onDisconnect
      }
    }
  }

  private async onMessage(port: chrome.runtime.Port, raw: unknown) {
    const parsed = PortMessageSchema.safeParse(raw);
    if (!parsed.success || parsed.data.kind !== "request") return;
    const req = parsed.data as PortRequest;

    const response: PortResponse = await this.dispatch(req);
    try {
      port.postMessage(response);
    } catch {
      // port disconnected during handling
    }
  }

  private async dispatch(req: PortRequest): Promise<PortResponse> {
    const handler = this.handlers[req.method];
    if (!handler) {
      return {
        kind: "response",
        id: req.id,
        ok: false,
        error: { message: `Unknown method: ${req.method}` },
      };
    }
    try {
      const result = await handler(...req.args);
      return { kind: "response", id: req.id, ok: true, result };
    } catch (err: unknown) {
      const e = err as Error;
      return {
        kind: "response",
        id: req.id,
        ok: false,
        error: { message: e.message ?? String(err), stack: e.stack },
      };
    }
  }
}
