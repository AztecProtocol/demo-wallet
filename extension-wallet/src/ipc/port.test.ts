import { describe, it, expect, beforeEach } from "vitest";
import { PortServer } from "./port-server";
import { PortClient } from "./port-client";

class MockPort {
  listeners: ((m: any) => void)[] = [];
  disconnectListeners: (() => void)[] = [];
  peer!: MockPort;
  name: string;
  constructor(name: string) {
    this.name = name;
  }
  postMessage(m: any) {
    queueMicrotask(() => this.peer.listeners.forEach((l) => l(m)));
  }
  onMessage = { addListener: (l: (m: any) => void) => this.listeners.push(l) };
  onDisconnect = { addListener: (l: () => void) => this.disconnectListeners.push(l) };
}

function installChromeMock() {
  const onConnectListeners: ((p: MockPort) => void)[] = [];
  (globalThis as any).chrome = {
    runtime: {
      onConnect: { addListener: (l: any) => onConnectListeners.push(l) },
      // PortClient pings the SW first; in tests we just say "ok" — the
      // server-side onConnect listener is already registered by the test setup.
      sendMessage: async (_msg: unknown) => ({ ok: true }),
      connect: (opts: { name: string }) => {
        const a = new MockPort(opts.name);
        const b = new MockPort(opts.name);
        a.peer = b;
        b.peer = a;
        queueMicrotask(() => onConnectListeners.forEach((l) => l(b)));
        return a;
      },
    },
  };
}

describe("Port transport", () => {
  beforeEach(() => installChromeMock());

  it("round-trips a request through server and client", async () => {
    const server = new PortServer({
      echo: async (s: unknown) => `echo:${s as string}`,
    });
    server.start();
    const client = new PortClient();
    client.connect();
    const result = await client.call<string>("echo", ["hello"]);
    expect(result).toBe("echo:hello");
  });

  it("delivers broadcasts to subscribed clients", async () => {
    const server = new PortServer({});
    server.start();
    const client = new PortClient();
    await client.connect();
    const seen: any[] = [];
    client.onBroadcast("wallet-update", (p) => seen.push(p));
    // Wait a microtask for the connect to register on the server side.
    await new Promise((r) => queueMicrotask(() => r(null)));
    server.broadcast("wallet-update", { foo: 1 });
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toEqual([{ foo: 1 }]);
  });
});
