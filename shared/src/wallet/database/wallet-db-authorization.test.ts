import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openTmpStore } from "@aztec/kv-store/lmdb-v2";
import { createLogger } from "@aztec/foundation/log";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { Fr } from "@aztec/aztec.js/fields";
import { WalletDB } from "./wallet-db";

const logger = createLogger("test:wallet-db");

let store: Awaited<ReturnType<typeof openTmpStore>>;
let db: WalletDB;

beforeEach(async () => {
  store = await openTmpStore("wallet-db-test");
  db = WalletDB.init(store, logger);
});

afterEach(async () => {
  await store.delete();
});

const APP_ID = "test-app";
const addr1 = AztecAddress.fromBigInt(1n);
const addr2 = AztecAddress.fromBigInt(2n);

describe("capabilityToStorageKeys", () => {
  it("converts each capability type to correct keys", () => {
    // accounts
    const accountsCap = {
      type: "accounts",
      canGet: true,
      canCreateAuthWit: true,
      accounts: [],
    } as any;
    expect(db.capabilityToStorageKeys(accountsCap)).toEqual(["getAccounts", "createAuthWit"]);

    // accounts without authwit
    const accountsNoAuth = {
      type: "accounts",
      canGet: true,
      canCreateAuthWit: false,
      accounts: [],
    } as any;
    expect(db.capabilityToStorageKeys(accountsNoAuth)).toEqual(["getAccounts"]);

    // contracts with specific addresses
    const contractsCap = {
      type: "contracts",
      contracts: [addr1],
      canRegister: true,
      canGetMetadata: true,
    } as any;
    const contractKeys = db.capabilityToStorageKeys(contractsCap);
    expect(contractKeys).toContain(`registerContract:${addr1.toString()}`);
    expect(contractKeys).toContain(`getContractMetadata:${addr1.toString()}`);

    // contracts with wildcard
    const contractsWild = {
      type: "contracts",
      contracts: "*",
      canRegister: true,
      canGetMetadata: false,
    } as any;
    expect(db.capabilityToStorageKeys(contractsWild)).toEqual(["registerContract:*"]);

    // simulation with patterns
    const simCap = {
      type: "simulation",
      transactions: { scope: [{ contract: addr1, function: "swap" }] },
      utilities: { scope: [{ contract: addr2, function: "balance_of" }] },
    } as any;
    const simKeys = db.capabilityToStorageKeys(simCap);
    expect(simKeys).toContain(`simulateTx:${addr1.toString()}:swap`);
    expect(simKeys).toContain(`simulateUtility:${addr2.toString()}:balance_of`);

    // transaction
    const txCap = {
      type: "transaction",
      scope: [{ contract: addr1, function: "transfer" }],
    } as any;
    expect(db.capabilityToStorageKeys(txCap)).toEqual([`sendTx:${addr1.toString()}:transfer`]);

    // data
    const dataCap = {
      type: "data",
      addressBook: true,
      privateEvents: { contracts: [addr1] },
    } as any;
    const dataKeys = db.capabilityToStorageKeys(dataCap);
    expect(dataKeys).toContain("getAddressBook");
    expect(dataKeys).toContain(`getPrivateEvents:${addr1.toString()}`);

    // contractClasses
    const classId = Fr.fromString("0x1234");
    const classCap = { type: "contractClasses", classes: [classId], canGetMetadata: true } as any;
    expect(db.capabilityToStorageKeys(classCap)).toEqual([
      `getContractClassMetadata:${classId.toString()}`,
    ]);
  });
});

describe("storeCapabilityGrants", () => {
  it("does not embed the full capability object in per-key stored values", async () => {
    // Guards against the quadratic-blowup regression that made the capability
    // cookie payload huge: we used to store the whole GrantedCapability under
    // `.capability` on every storage key it expanded into.
    const cap = {
      type: "contracts",
      contracts: [addr1, addr2],
      canRegister: true,
      canGetMetadata: true,
    } as any;
    await db.storeCapabilityGrants(APP_ID, [cap]);

    for (const key of [
      `registerContract:${addr1.toString()}`,
      `registerContract:${addr2.toString()}`,
      `getContractMetadata:${addr1.toString()}`,
      `getContractMetadata:${addr2.toString()}`,
    ]) {
      const data = await db.retrievePersistentAuthorization(APP_ID, key);
      expect(data).toBeDefined();
      expect(data).not.toHaveProperty("capability");
    }
  });

  it("stores additively and appends to __requested__", async () => {
    // Ad-hoc grant
    await db.storePersistentAuthorization(APP_ID, "getAccounts", {
      persistent: true,
      accounts: [],
    });

    // Manifest-based grant (should NOT delete the ad-hoc one)
    const simCap = { type: "simulation", transactions: { scope: "*" } } as any;
    await db.storeCapabilityGrants(APP_ID, [simCap]);

    // Both exist
    expect(await db.retrievePersistentAuthorization(APP_ID, "getAccounts")).toBeDefined();
    expect(await db.retrievePersistentAuthorization(APP_ID, "simulateTx:*")).toBeDefined();

    // __requested__ updated
    const requestedKeys = await db.getRequestedKeys(APP_ID);
    expect(requestedKeys).toContain("simulateTx:*");
  });

  it("tracks denied capabilities in __requested__ when requestedCapabilities provided", async () => {
    const grantedCap = {
      type: "accounts",
      canGet: true,
      canCreateAuthWit: false,
      accounts: [],
    } as any;
    const deniedCap = { type: "simulation", transactions: { scope: "*" } } as any;

    await db.storeCapabilityGrants(APP_ID, [grantedCap], [grantedCap, deniedCap]);

    // Only accounts authorized
    expect(await db.retrievePersistentAuthorization(APP_ID, "getAccounts")).toBeDefined();
    expect(await db.retrievePersistentAuthorization(APP_ID, "simulateTx:*")).toBeUndefined();

    // Both in __requested__
    const requestedKeys = await db.getRequestedKeys(APP_ID);
    expect(requestedKeys).toContain("getAccounts");
    expect(requestedKeys).toContain("simulateTx:*");
  });
});

describe("appendRequestedKeys / getRequestedKeys", () => {
  it("accumulates and deduplicates across calls", async () => {
    await db.appendRequestedKeys(APP_ID, ["getAccounts", "simulateTx:*"]);
    await db.appendRequestedKeys(APP_ID, ["getAccounts", "createAuthWit"]);

    const keys = await db.getRequestedKeys(APP_ID);
    expect(keys).toHaveLength(3);
    expect(keys).toContain("getAccounts");
    expect(keys).toContain("simulateTx:*");
    expect(keys).toContain("createAuthWit");
  });

  it("returns empty array for unknown app", async () => {
    expect(await db.getRequestedKeys("unknown-app")).toEqual([]);
  });
});

describe("revokeCapability", () => {
  it("deletes auth keys but preserves __requested__, doesn't affect other capabilities", async () => {
    const cap1 = { type: "accounts", canGet: true, canCreateAuthWit: false, accounts: [] } as any;
    const cap2 = { type: "simulation", transactions: { scope: "*" } } as any;

    await db.storeCapabilityGrants(APP_ID, [cap1, cap2]);
    await db.revokeCapability(APP_ID, cap2);

    // Accounts still there
    expect(await db.retrievePersistentAuthorization(APP_ID, "getAccounts")).toBeDefined();
    // Simulation gone
    expect(await db.retrievePersistentAuthorization(APP_ID, "simulateTx:*")).toBeUndefined();
    // __requested__ still has both
    const requestedKeys = await db.getRequestedKeys(APP_ID);
    expect(requestedKeys).toContain("simulateTx:*");
    expect(requestedKeys).toContain("getAccounts");
  });
});

describe("reconstructCapabilitiesFromKeys", () => {
  it("reconstructs from ad-hoc stored keys", async () => {
    await db.storePersistentAuthorization(APP_ID, "getAccounts", {
      persistent: true,
      accounts: [{ alias: "My Account", item: addr1.toString() }],
    });
    await db.storePersistentAuthorization(APP_ID, `registerContract:${addr1.toString()}`, {
      persistent: true,
    });

    const caps = await db.reconstructCapabilitiesFromKeys(APP_ID);
    const accountsCap = caps.find((c) => c.type === "accounts") as any;
    expect(accountsCap).toBeDefined();
    expect(accountsCap.canGet).toBe(true);
    expect(accountsCap.accounts).toHaveLength(1);

    const contractsCap = caps.find((c) => c.type === "contracts") as any;
    expect(contractsCap).toBeDefined();
    expect(contractsCap.canRegister).toBe(true);
  });

  it("getRequestedCapabilities reconstructs from __requested__ keys", async () => {
    await db.appendRequestedKeys(APP_ID, [
      "getAccounts",
      "createAuthWit",
      "simulateTx:*",
      `registerContract:${addr1.toString()}`,
    ]);

    const caps = await db.getRequestedCapabilities(APP_ID);
    const types = caps.map((c) => c.type);
    expect(types).toContain("accounts");
    expect(types).toContain("simulation");
    expect(types).toContain("contracts");
  });
});

describe("listAuthorizedApps", () => {
  it("finds apps by markers, handles URL appIds, deduplicates", async () => {
    // Plain app with both markers
    await db.appendRequestedKeys(APP_ID, ["getAccounts"]);
    await db.storeAppAuthorizationBehavior(APP_ID, "strict", 86400000);

    // URL app
    const urlAppId = "https://my-dapp.example.com";
    await db.appendRequestedKeys(urlAppId, ["getAccounts"]);

    const apps = await db.listAuthorizedApps();
    expect(apps).toContain(APP_ID);
    expect(apps).toContain(urlAppId);
    expect(apps).not.toContain("https");
    // No duplicates
    expect(apps.filter((a) => a === APP_ID)).toHaveLength(1);
  });
});

describe("revokeAppAuthorizations", () => {
  it("revokes all keys for a URL appId", async () => {
    const urlAppId = "https://my-dapp.example.com";
    await db.appendRequestedKeys(urlAppId, ["getAccounts"]);
    await db.storePersistentAuthorization(urlAppId, "getAccounts", { persistent: true });
    await db.storeAppAuthorizationBehavior(urlAppId, "permissive", 86400000);

    await db.revokeAppAuthorizations(urlAppId);

    expect(await db.listAuthorizedApps()).not.toContain(urlAppId);
    expect(await db.getRequestedKeys(urlAppId)).toEqual([]);
  });
});

describe("requested vs granted separation", () => {
  it("requested persists after revocation, granted does not", async () => {
    const simCap = { type: "simulation", transactions: { scope: "*" } } as any;
    await db.storeCapabilityGrants(APP_ID, [simCap]);
    await db.revokeCapability(APP_ID, simCap);

    const requested = await db.getRequestedCapabilities(APP_ID);
    expect(requested.map((c) => c.type)).toContain("simulation");

    const granted = await db.reconstructCapabilitiesFromKeys(APP_ID);
    expect(granted.map((c) => c.type)).not.toContain("simulation");
  });
});

describe("capability removal round-trips", () => {
  it("removing contract metadata for one contract doesn't affect others", async () => {
    // Grant register + metadata for both contracts
    const cap = {
      type: "contracts",
      contracts: [addr1, addr2],
      canRegister: true,
      canGetMetadata: true,
    } as any;
    await db.storeCapabilityGrants(APP_ID, [cap]);

    // Simulate UI removing metadata for addr1: delete the key directly
    await db.revokeAuthorization(`${APP_ID}:getContractMetadata:${addr1.toString()}`);

    // Re-store only what remains (register for both, metadata for addr2 only)
    const newCaps = [
      {
        type: "contracts",
        contracts: [addr1, addr2],
        canRegister: true,
        canGetMetadata: false,
      } as any,
      { type: "contracts", contracts: [addr2], canRegister: false, canGetMetadata: true } as any,
    ];
    await db.storeCapabilityGrants(APP_ID, newCaps);

    // Reconstruct and verify round-trip
    const granted = await db.reconstructCapabilitiesFromKeys(APP_ID);
    const allKeys = granted.flatMap((c) => db.capabilityToStorageKeys(c));

    expect(allKeys).toContain(`registerContract:${addr1.toString()}`);
    expect(allKeys).toContain(`registerContract:${addr2.toString()}`);
    expect(allKeys).not.toContain(`getContractMetadata:${addr1.toString()}`);
    expect(allKeys).toContain(`getContractMetadata:${addr2.toString()}`);
  });

  it("removing one account preserves remaining accounts in data blob", async () => {
    const cap = {
      type: "accounts",
      canGet: true,
      canCreateAuthWit: false,
      accounts: [
        { alias: "Account 1", item: addr1 },
        { alias: "Account 2", item: addr2 },
      ],
    } as any;
    await db.storeCapabilityGrants(APP_ID, [cap]);

    // Now re-store with only addr1
    const updatedCap = {
      type: "accounts",
      canGet: true,
      canCreateAuthWit: false,
      accounts: [{ alias: "Account 1", item: addr1 }],
    } as any;
    await db.storeCapabilityGrants(APP_ID, [updatedCap]);

    // Reconstruct
    const granted = await db.reconstructCapabilitiesFromKeys(APP_ID);
    const accountsCap = granted.find((c) => c.type === "accounts") as any;
    expect(accountsCap).toBeDefined();
    expect(accountsCap.accounts).toHaveLength(1);
    expect(accountsCap.accounts[0].item.toString()).toBe(addr1.toString());
  });

  it("reconstruct → toKeys round-trip is lossless for per-contract permissions", async () => {
    // Store mixed permissions: addr1 has register only, addr2 has both
    await db.storePersistentAuthorization(APP_ID, `registerContract:${addr1.toString()}`, {
      persistent: true,
    });
    await db.storePersistentAuthorization(APP_ID, `registerContract:${addr2.toString()}`, {
      persistent: true,
    });
    await db.storePersistentAuthorization(APP_ID, `getContractMetadata:${addr2.toString()}`, {
      persistent: true,
    });

    const granted = await db.reconstructCapabilitiesFromKeys(APP_ID);
    const roundTrippedKeys = new Set(granted.flatMap((c) => db.capabilityToStorageKeys(c)));

    expect(roundTrippedKeys.has(`registerContract:${addr1.toString()}`)).toBe(true);
    expect(roundTrippedKeys.has(`registerContract:${addr2.toString()}`)).toBe(true);
    expect(roundTrippedKeys.has(`getContractMetadata:${addr2.toString()}`)).toBe(true);
    // addr1 should NOT have metadata key
    expect(roundTrippedKeys.has(`getContractMetadata:${addr1.toString()}`)).toBe(false);
  });

  it("reconstruct → toKeys round-trip handles simulation removal", async () => {
    const simCap = {
      type: "simulation",
      transactions: {
        scope: [
          { contract: addr1, function: "swap" },
          { contract: addr2, function: "transfer" },
        ],
      },
    } as any;
    await db.storeCapabilityGrants(APP_ID, [simCap]);

    // Remove one simulation pattern
    await db.revokeAuthorization(`${APP_ID}:simulateTx:${addr1.toString()}:swap`);

    const granted = await db.reconstructCapabilitiesFromKeys(APP_ID);
    const allKeys = granted.flatMap((c) => db.capabilityToStorageKeys(c));

    expect(allKeys).not.toContain(`simulateTx:${addr1.toString()}:swap`);
    expect(allKeys).toContain(`simulateTx:${addr2.toString()}:transfer`);
  });
});

describe("metadata preservation", () => {
  it("preserves __behavior__ and __requested__ across storeCapabilityGrants", async () => {
    await db.storeAppAuthorizationBehavior(APP_ID, "strict", 86400000);
    await db.appendRequestedKeys(APP_ID, ["getAccounts", "simulateTx:*"]);

    const cap = { type: "data", addressBook: true } as any;
    await db.storeCapabilityGrants(APP_ID, [cap]);

    // __behavior__ preserved
    const behavior = await db.getAppAuthorizationBehavior(APP_ID);
    expect(behavior!.mode).toBe("strict");

    // __requested__ preserved and extended
    const keys = await db.getRequestedKeys(APP_ID);
    expect(keys).toContain("getAccounts");
    expect(keys).toContain("simulateTx:*");
    expect(keys).toContain("getAddressBook");
  });
});
