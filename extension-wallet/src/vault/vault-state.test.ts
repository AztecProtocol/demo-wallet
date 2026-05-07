import { describe, it, expect, beforeEach, vi } from "vitest";
import { VaultState } from "./vault-state";

// Mock the meta store so tests don't hit IndexedDB.
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

// Each test triggers ~1-2 Argon2id derivations under production params (~2-5s each in CI).
const VAULT_TEST_TIMEOUT = 30_000;

describe("VaultState", () => {
  beforeEach(async () => {
    const meta = await import("./vault-meta");
    (meta as any).__reset();
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
    "lock clears the in-memory key",
    async () => {
      const v = new VaultState();
      await v.initialize("hunter2");
      v.lock();
      expect(v.isUnlocked()).toBe(false);
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
    "unlock with wrong password fails and stays locked",
    async () => {
      const v = new VaultState();
      await v.initialize("hunter2");
      v.lock();
      expect(await v.unlock("hunter3")).toBe(false);
      expect(v.isUnlocked()).toBe(false);
    },
    VAULT_TEST_TIMEOUT,
  );
});
