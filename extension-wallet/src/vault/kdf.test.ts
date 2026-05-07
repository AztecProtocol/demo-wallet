import { describe, it, expect } from "vitest";
import { deriveKey, DEFAULT_KDF_PARAMS } from "./kdf";

// Production-grade Argon2id at DEFAULT_KDF_PARAMS runs ~2-5s per derivation under CI/sandbox load.
const KDF_TEST_TIMEOUT = 30_000;

describe("deriveKey (Argon2id)", () => {
  it(
    "is deterministic given the same salt and password",
    async () => {
      const salt = new Uint8Array(16).fill(7);
      const k1 = await deriveKey("hunter2", salt, DEFAULT_KDF_PARAMS);
      const k2 = await deriveKey("hunter2", salt, DEFAULT_KDF_PARAMS);
      expect(Array.from(k1)).toEqual(Array.from(k2));
    },
    KDF_TEST_TIMEOUT,
  );

  it(
    "produces different keys for different passwords",
    async () => {
      const salt = new Uint8Array(16).fill(7);
      const k1 = await deriveKey("hunter2", salt, DEFAULT_KDF_PARAMS);
      const k2 = await deriveKey("hunter3", salt, DEFAULT_KDF_PARAMS);
      expect(Array.from(k1)).not.toEqual(Array.from(k2));
    },
    KDF_TEST_TIMEOUT,
  );

  it(
    "produces different keys for different salts",
    async () => {
      const a = await deriveKey("hunter2", new Uint8Array(16).fill(1), DEFAULT_KDF_PARAMS);
      const b = await deriveKey("hunter2", new Uint8Array(16).fill(2), DEFAULT_KDF_PARAMS);
      expect(Array.from(a)).not.toEqual(Array.from(b));
    },
    KDF_TEST_TIMEOUT,
  );
});
