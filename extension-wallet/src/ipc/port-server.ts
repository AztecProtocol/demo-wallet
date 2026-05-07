import { jsonStringify } from "@aztec/foundation/json-rpc";
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
    } catch (err) {
      // postMessage failed with DataCloneError or similar. Wallet results
      // often contain class instances with `toJSON()` (Fr, AztecAddress,
      // TxSimulationResult) — JSON.stringify is more permissive than
      // structured clone for these. Fall back to a stringified result.
      console.warn("[PortServer] postMessage failed; retrying as JSON", {
        method: req.method,
        id: req.id,
        error: (err as Error).message,
      });
      try {
        // Use the foundation's `jsonStringify` instead of plain
        // `JSON.stringify`: it handles BigInt (→ decimal string), Buffer
        // (→ base64), Map / Set, plus respects `toJSON()`. This matches the
        // wire format the wallet-sdk uses internally.
        port.postMessage({
          ...response,
          result: response.ok ? jsonStringify(response.result) : undefined,
          resultIsJson: response.ok,
        } satisfies PortResponse);
      } catch (fallbackErr) {
        // JSON.stringify failure (rare — typically circular refs only).
        // Send an error response so the caller doesn't hang.
        console.error("[PortServer] JSON fallback also failed", {
          method: req.method,
          id: req.id,
          error: (fallbackErr as Error).message,
        });
        try {
          port.postMessage({
            kind: "response",
            id: req.id,
            ok: false,
            error: {
              message: `Response not serializable: ${(fallbackErr as Error).message}`,
            },
          } satisfies PortResponse);
        } catch {
          // Truly disconnected; nothing more to do.
        }
      }
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
