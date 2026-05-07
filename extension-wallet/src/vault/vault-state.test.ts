import { describe, it, expect, beforeEach, vi } from "vitest";
import { VaultState } from "./vault-state";

// Mock the meta store so tests don't hit chrome.storage.local.
vi.mock("./vault-meta", () => {
  let stored: any = null;
  return {
    readVaultMeta: vi.fn(async () => stored),
    writeVaultMeta: vi.fn(async (m: any) => {
      stored = m;
    }),
    hasVaultMeta: vi.fn(async () => stored !== null),
    __reset: () => {
      stored = null;
    },
  };
});

// Mock the encrypted store opener so tests don't need a real OPFS context.
// Each call returns a fresh fake-store object so we can verify caching.
const fakeStores: Array<{ close: ReturnType<typeof vi.fn> }> = [];
vi.mock("@aztec/kv-store/sqlite-opfs", () => ({
  openEncryptedStore: vi.fn(async () => {
    const s = { close: vi.fn(async () => {}) };
    fakeStores.push(s);
    return s;
  }),
}));

// Each test triggers ~1-2 Argon2id derivations under production params (~2-5s each in CI).
const VAULT_TEST_TIMEOUT = 30_000;

describe("VaultState", () => {
  beforeEach(async () => {
    const meta = await import("./vault-meta");
    (meta as any).__reset();
    fakeStores.length = 0;
  });

  it("starts locked when no meta exists", async () => {
    const v = new VaultState();
    expect(v.isUnlocked()).toBe(false);
    expect(await v.isInitialized()).toBe(false);
  });

  it(
    "initialize sets meta and unlocks",
    async () => {
      const v = new VaultState();
      await v.initialize("hunter2");
      expect(v.isUnlocked()).toBe(true);
      expect(await v.isInitialized()).toBe(true);
    },
    VAULT_TEST_TIMEOUT,
  );

  it(
    "rejects re-initialization",
    async () => {
      const v1 = new VaultState();
      await v1.initialize("hunter2");
      const v2 = new VaultState();
      await expect(v2.initialize("anotherpw")).rejects.toThrow(/already initialized/);
    },
    VAULT_TEST_TIMEOUT,
  );

  it(
    "lock clears the in-memory key and closes open stores",
    async () => {
      const v = new VaultState();
      await v.initialize("hunter2");
      const s = await v.getStore("wallet-foo");
      v.lock();
      expect(v.isUnlocked()).toBe(false);
      expect(s.close).toHaveBeenCalled();
    },
    VAULT_TEST_TIMEOUT,
  );

  it(
    "unlock with correct password succeeds",
    async () => {
      const v = new VaultState();
      await v.initialize("hunter2");
      v.lock();
      expect(await v.unlock("hunter2")).toBe(true);
      expect(v.isUnlocked()).toBe(true);
    },
    VAULT_TEST_TIMEOUT,
  );

  it(
    "unlock returns false when no meta exists",
    async () => {
      const v = new VaultState();
      expect(await v.unlock("anything")).toBe(false);
      expect(v.isUnlocked()).toBe(false);
    },
    VAULT_TEST_TIMEOUT,
  );

  it(
    "getStore throws when locked",
    async () => {
      const v = new VaultState();
      await expect(v.getStore("wallet-foo")).rejects.toThrow(/locked/);
    },
    VAULT_TEST_TIMEOUT,
  );

  it(
    "getStore returns a store when unlocked",
    async () => {
      const v = new VaultState();
      await v.initialize("hunter2");
      const s = await v.getStore("wallet-foo");
      expect(s).toBeDefined();
    },
    VAULT_TEST_TIMEOUT,
  );

  it(
    "caches store handles per name",
    async () => {
      const v = new VaultState();
      await v.initialize("hunter2");
      const s1 = await v.getStore("wallet-foo");
      const s2 = await v.getStore("wallet-foo");
      expect(s1).toBe(s2);
      // Different name → different store
      const s3 = await v.getStore("pxe-foo");
      expect(s3).not.toBe(s1);
    },
    VAULT_TEST_TIMEOUT,
  );

  it(
    "after lock, getStore throws again",
    async () => {
      const v = new VaultState();
      await v.initialize("hunter2");
      await v.getStore("wallet-foo");
      v.lock();
      await expect(v.getStore("wallet-foo")).rejects.toThrow(/locked/);
    },
    VAULT_TEST_TIMEOUT,
  );

  it(
    "notifies listeners on state change",
    async () => {
      const v = new VaultState();
      const listener = vi.fn();
      v.onChange(listener);
      await v.initialize("hunter2");
      v.lock();
      expect(listener).toHaveBeenCalledWith("unlocked");
      expect(listener).toHaveBeenCalledWith("locked");
    },
    VAULT_TEST_TIMEOUT,
  );
});
