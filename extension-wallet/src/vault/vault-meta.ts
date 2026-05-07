import type { KdfParams } from "./kdf";

/**
 * Vault metadata persists unencrypted because we need the salt + KDF params
 * to re-derive the encryption key from the user's password on each unlock.
 * They aren't secrets. Living in `chrome.storage.local` keeps the dependency
 * footprint small (no IndexedDB just for this) and survives extension reload.
 *
 * The previous version lived in an IndexedDB store and also held a
 * `vaultProbe` (a known plaintext encrypted with the password key) used to
 * detect wrong passwords. With sqlite3mc encryption-at-rest the probe is
 * unnecessary — opening the encrypted store with the wrong key fails, which
 * is itself a sufficient probe.
 */

const STORAGE_KEY = "vault-meta";

export interface VaultMeta {
  kdfSalt: Uint8Array;
  kdfParams: KdfParams;
}

interface SerializedMeta {
  /** chrome.storage.local can't carry Uint8Array directly; serialize as number[]. */
  kdfSalt: number[];
  kdfParams: KdfParams;
}

export async function hasVaultMeta(): Promise<boolean> {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  return result[STORAGE_KEY] !== undefined;
}

export async function readVaultMeta(): Promise<VaultMeta | null> {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  const raw = result[STORAGE_KEY] as SerializedMeta | undefined;
  if (!raw) return null;
  return {
    kdfSalt: Uint8Array.from(raw.kdfSalt),
    kdfParams: raw.kdfParams,
  };
}

export async function writeVaultMeta(meta: VaultMeta): Promise<void> {
  const serialized: SerializedMeta = {
    kdfSalt: Array.from(meta.kdfSalt),
    kdfParams: meta.kdfParams,
  };
  await chrome.storage.local.set({ [STORAGE_KEY]: serialized });
}
