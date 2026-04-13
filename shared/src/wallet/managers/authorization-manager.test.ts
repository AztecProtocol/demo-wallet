import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openTmpStore } from "@aztec/kv-store/lmdb-v2";
import { createLogger } from "@aztec/foundation/log";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { AuthorizationManager } from "./authorization-manager";
import { WalletDB } from "../database/wallet-db";
import type { AuthorizationItem, AuthorizationResponse } from "../types/authorization";

const logger = createLogger("test:auth-manager");
const contractAddr = AztecAddress.fromBigInt(42n).toString();
const contractAddr2 = AztecAddress.fromBigInt(43n).toString();

let store: Awaited<ReturnType<typeof openTmpStore>>;
let db: WalletDB;
let pendingAuthorizations: Map<string, any>;
let eventEmitter: EventTarget;
let manager: AuthorizationManager;

const APP_ID = "test-app";

beforeEach(async () => {
  store = await openTmpStore("auth-manager-test");
  db = WalletDB.init(store, logger);
  pendingAuthorizations = new Map();
  eventEmitter = new EventTarget();
  manager = new AuthorizationManager(APP_ID, db, pendingAuthorizations, eventEmitter);
});

afterEach(async () => {
  await store.delete();
});

/**
 * Helper: Listen for authorization request event and auto-approve all items.
 */
function autoApproveAll(appId = APP_ID) {
  eventEmitter.addEventListener("authorization-request", (event: any) => {
    const request = JSON.parse(event.detail);
    const itemResponses: Record<string, any> = {};
    for (const item of request.items) {
      itemResponses[item.id] = {
        id: item.id,
        approved: true,
        appId,
        data: { persistent: true },
      };
    }
    const pending = pendingAuthorizations.get(request.id);
    if (pending) {
      pending.promise.resolve({
        id: request.id,
        approved: true,
        appId,
        itemResponses,
      } as AuthorizationResponse);
    }
  });
}

function makeItem(overrides: Partial<AuthorizationItem> & { id: string }): AuthorizationItem {
  return {
    appId: APP_ID,
    method: "simulateTx",
    params: {},
    timestamp: Date.now(),
    ...overrides,
  };
}

describe("auto-approval with existing grants", () => {
  it("auto-approves exact key and tracks in __requested__", async () => {
    await db.storePersistentAuthorization(APP_ID, "getAccounts", {
      persistent: true,
      accounts: [],
    });

    const items = [
      makeItem({
        id: "item-1",
        method: "getAccounts",
        persistence: { storageKey: "getAccounts", persistData: null },
      }),
    ];
    const response = await manager.requestAuthorization(items);

    expect(response.approved).toBe(true);
    expect(response.itemResponses["item-1"].approved).toBe(true);
    expect(await db.getRequestedKeys(APP_ID)).toContain("getAccounts");
  });

  it("auto-approves with wildcard patterns (one-level and two-level)", async () => {
    // One-level wildcard: registerContract:* matches registerContract:0x123
    await db.storePersistentAuthorization(APP_ID, "registerContract:*", { persistent: true });
    const regKey = `registerContract:${contractAddr}`;
    let response = await manager.requestAuthorization([
      makeItem({
        id: "item-1",
        method: "registerContract",
        persistence: { storageKey: regKey, persistData: null },
      }),
    ]);
    expect(response.approved).toBe(true);

    // Two-level wildcard: simulateTx:contract:* matches simulateTx:contract:swap
    await db.storePersistentAuthorization(APP_ID, `simulateTx:${contractAddr}:*`, {
      persistent: true,
    });
    response = await manager.requestAuthorization([
      makeItem({
        id: "item-2",
        persistence: { storageKey: `simulateTx:${contractAddr}:swap`, persistData: null },
      }),
    ]);
    expect(response.approved).toBe(true);

    // Full wildcard: simulateTx:* matches simulateTx:contract:function
    await db.storePersistentAuthorization(APP_ID, "simulateTx:*", { persistent: true });
    response = await manager.requestAuthorization([
      makeItem({
        id: "item-3",
        persistence: { storageKey: `simulateTx:${contractAddr2}:transfer`, persistData: null },
      }),
    ]);
    expect(response.approved).toBe(true);

    // All specific keys tracked in __requested__
    const requested = await db.getRequestedKeys(APP_ID);
    expect(requested).toContain(regKey);
    expect(requested).toContain(`simulateTx:${contractAddr}:swap`);
    expect(requested).toContain(`simulateTx:${contractAddr2}:transfer`);
  });
});

describe("strict mode", () => {
  it("rejects unauthorized operations but allows requestCapabilities", async () => {
    await db.storeAppAuthorizationBehavior(APP_ID, "strict", 86400000);
    autoApproveAll();

    // Unauthorized operation → rejected
    await expect(
      manager.requestAuthorization([
        makeItem({
          id: "item-1",
          persistence: { storageKey: `simulateTx:${contractAddr}:swap`, persistData: null },
        }),
      ]),
    ).rejects.toThrow("strict mode");

    // requestCapabilities → allowed even in strict mode
    const response = await manager.requestAuthorization([
      makeItem({ id: "item-2", method: "requestCapabilities" }),
    ]);
    expect(response.approved).toBe(true);
  });
});

describe("ad-hoc approval tracks in __requested__", () => {
  it("tracks single and array storageKeys", async () => {
    autoApproveAll();

    const key1 = `simulateTx:${contractAddr}:swap`;
    const key2 = `simulateTx:${contractAddr2}:transfer`;

    // Single key
    await manager.requestAuthorization([
      makeItem({ id: "item-1", persistence: { storageKey: key1, persistData: null } }),
    ]);

    // Array of keys
    await manager.requestAuthorization([
      makeItem({
        id: "item-2",
        persistence: { storageKey: [key2, "getAccounts"], persistData: null },
      }),
    ]);

    const requested = await db.getRequestedKeys(APP_ID);
    expect(requested).toContain(key1);
    expect(requested).toContain(key2);
    expect(requested).toContain("getAccounts");
  });
});

describe("mixed auto-approved and needs-auth items", () => {
  it("auto-approves pre-granted, prompts for new, tracks all in __requested__", async () => {
    await db.storePersistentAuthorization(APP_ID, "getAccounts", {
      persistent: true,
      accounts: [],
    });
    autoApproveAll();

    const simKey = `simulateTx:${contractAddr}:swap`;
    const items = [
      makeItem({
        id: "item-1",
        method: "getAccounts",
        persistence: { storageKey: "getAccounts", persistData: null },
      }),
      makeItem({ id: "item-2", persistence: { storageKey: simKey, persistData: null } }),
    ];

    const response = await manager.requestAuthorization(items);
    expect(response.approved).toBe(true);
    expect(response.itemResponses["item-1"].approved).toBe(true);
    expect(response.itemResponses["item-2"].approved).toBe(true);

    const requested = await db.getRequestedKeys(APP_ID);
    expect(requested).toContain("getAccounts");
    expect(requested).toContain(simKey);
  });
});

describe("URL appId ad-hoc flow", () => {
  const URL_APP_ID = "https://my-dapp.example.com";
  let urlManager: AuthorizationManager;

  beforeEach(() => {
    urlManager = new AuthorizationManager(URL_APP_ID, db, pendingAuthorizations, eventEmitter);
  });

  it("accumulates ad-hoc requests, shows in listAuthorizedApps, reconstructs capabilities", async () => {
    autoApproveAll(URL_APP_ID);

    const regKey = `registerContract:${contractAddr}`;
    const simKey = `simulateTx:${contractAddr}:swap`;

    // Three sequential ad-hoc requests
    await urlManager.requestAuthorization([
      makeItem({
        id: "item-1",
        appId: URL_APP_ID,
        method: "getAccounts",
        persistence: { storageKey: "getAccounts", persistData: null },
      }),
    ]);
    await urlManager.requestAuthorization([
      makeItem({
        id: "item-2",
        appId: URL_APP_ID,
        method: "registerContract",
        persistence: { storageKey: regKey, persistData: null },
      }),
    ]);
    await urlManager.requestAuthorization([
      makeItem({
        id: "item-3",
        appId: URL_APP_ID,
        persistence: { storageKey: simKey, persistData: null },
      }),
    ]);

    // Full URL in listAuthorizedApps, not "https"
    const apps = await db.listAuthorizedApps();
    expect(apps).toContain(URL_APP_ID);
    expect(apps).not.toContain("https");

    // All keys accumulated
    const requested = await db.getRequestedKeys(URL_APP_ID);
    expect(requested).toContain("getAccounts");
    expect(requested).toContain(regKey);
    expect(requested).toContain(simKey);

    // Capabilities reconstructed correctly
    const caps = await db.getRequestedCapabilities(URL_APP_ID);
    const types = caps.map((c) => c.type);
    expect(types).toContain("accounts");
    expect(types).toContain("contracts");
    expect(types).toContain("simulation");
  });
});
