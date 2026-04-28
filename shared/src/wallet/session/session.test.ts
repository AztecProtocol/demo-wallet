import { describe, it, expect, beforeEach } from "vitest";
import { Fr } from "@aztec/aztec.js/fields";
import type { ChainInfo } from "@aztec/aztec.js/account";
import type { AztecNode } from "@aztec/aztec.js/node";
import {
  getOrCreateSession,
  getRunningSessionIds,
  __resetSessionsForTests,
  __setSharedResourcesFactoryForTests,
  __setNodeClientFactoryForTests,
  type SharedResources,
} from "./session";

const CHAIN_A: ChainInfo = { chainId: new Fr(31337), version: new Fr(1) };
const CHAIN_B: ChainInfo = { chainId: new Fr(31337), version: new Fr(2) };

/**
 * The session manager's `getOrCreateSession` does real PXE init: it spins up
 * an Aztec node client and calls `node.getL1ContractAddresses()`, which
 * requires a running Aztec node and a browser-like environment with
 * IndexedDB. These tests cover only the routing/keying logic, so we stub
 * out both the node-client factory and the shared-resources factory.
 *
 * The `ExternalWallet` / `InternalWallet` constructors are still real (they
 * are the things we want to verify get instantiated correctly per appId),
 * but they only need a `pxe`, `node`, and `db` reference; they do not call
 * methods on those during construction.
 */
function fakeNodeClient(): AztecNode {
  return {} as AztecNode;
}

function fakeSharedResources(): SharedResources {
  return {
    // The wallet constructors store these references; they are not invoked
    // during construction or wireEvents, so empty objects suffice.
    pxe: {} as SharedResources["pxe"],
    node: fakeNodeClient(),
    db: {} as SharedResources["db"],
    pendingAuthorizations: new Map(),
  };
}

describe("session manager", () => {
  beforeEach(() => {
    __resetSessionsForTests();
    __setNodeClientFactoryForTests(() => fakeNodeClient());
    __setSharedResourcesFactoryForTests(async () => fakeSharedResources());
  });

  it("creates a session keyed by chainId-version and reuses it", async () => {
    const a1 = await getOrCreateSession(CHAIN_A, "app-1", () => {});
    const a2 = await getOrCreateSession(CHAIN_A, "app-2", () => {});
    expect(getRunningSessionIds()).toEqual(["31337-1"]);
    expect(a1.external).not.toBe(a2.external); // separate appIds → separate wallets
  });

  it("creates separate sessions for different chainId-version", async () => {
    await getOrCreateSession(CHAIN_A, "app-1", () => {});
    await getOrCreateSession(CHAIN_B, "app-1", () => {});
    expect(getRunningSessionIds().sort()).toEqual(["31337-1", "31337-2"]);
  });

  it("returns the same wallet pair for the same (session, appId)", async () => {
    const w1 = await getOrCreateSession(CHAIN_A, "app-1", () => {});
    const w2 = await getOrCreateSession(CHAIN_A, "app-1", () => {});
    expect(w1.external).toBe(w2.external);
    expect(w1.internal).toBe(w2.internal);
  });
});
