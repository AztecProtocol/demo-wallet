import { openEncryptedStore } from "@aztec/kv-store/sqlite-opfs";
import type { AztecAsyncKVStore } from "@aztec/kv-store";
import { deriveKey, generateSalt, DEFAULT_KDF_PARAMS } from "./kdf";
import { hasVaultMeta, readVaultMeta, writeVaultMeta } from "./vault-meta";

type Listener = (state: "locked" | "unlocked") => void;

/**
 * VaultState owns the in-memory key AND every currently-open encrypted
 * sqlite-opfs store. Stores are opened lazily on first request after unlock,
 * cached for reuse, and closed on lock. `getStore(name)` is the single API
 * the wallet code uses to obtain a kv-store; it throws if locked.
 *
 * Wrong-password detection is implicit: the password is verified by the
 * first store open. If wrong, sqlite3mc fails to open and we surface that
 * to the caller as "Incorrect password".
 */
export class VaultState {
  private unlockedKey: Uint8Array | null = null;
  private openStores = new Map<string, AztecAsyncKVStore>();
  private listeners = new Set<Listener>();

  isUnlocked(): boolean {
    return this.unlockedKey !== null;
  }

  isInitialized(): Promise<boolean> {
    return hasVaultMeta();
  }

  /** First-install: pick a password, write meta, leave unlocked. */
  async initialize(password: string): Promise<void> {
    if (await hasVaultMeta()) {
      throw new Error("Vault already initialized");
    }
    const kdfSalt = generateSalt();
    const kdfParams = DEFAULT_KDF_PARAMS;
    const key = await deriveKey(password, kdfSalt, kdfParams);
    await writeVaultMeta({ kdfSalt, kdfParams });
    this.unlockedKey = key;
    this.notify("unlocked");
  }

  /**
   * Try to unlock with a password. Returns true if a vault exists and the key
   * is now in memory. Returns false only if no vault has been initialized.
   *
   * Wrong-password detection is deferred to the first `getStore(...)` call —
   * sqlite3mc fails to open with the wrong key. Callers that want immediate
   * feedback can call `getStore("vault-probe")` (or any well-known name)
   * right after unlock.
   */
  async unlock(password: string): Promise<boolean> {
    const meta = await readVaultMeta();
    if (!meta) return false;
    const key = await deriveKey(password, meta.kdfSalt, meta.kdfParams);
    this.unlockedKey = key;
    this.notify("unlocked");
    return true;
  }

  lock(): void {
    if (!this.unlockedKey) return;
    this.unlockedKey.fill(0);
    this.unlockedKey = null;
    for (const store of this.openStores.values()) {
      void store.close().catch(() => {
        // Best-effort: a close failure during lock isn't recoverable; the
        // OPFS file is already encrypted at rest, and we've zeroed the key.
      });
    }
    this.openStores.clear();
    this.notify("locked");
  }

  /**
   * Open (or return cached) encrypted store with the given name. Throws if
   * the vault is locked. Uses the in-memory key as the encryption key.
   *
   * Two upstream-API quirks need handling here:
   *
   * 1. **Key buffer is transferred, not cloned.** `openEncryptedStore` moves
   *    the key's ArrayBuffer to its worker via `postMessage` transfer list,
   *    detaching the caller's view. We hold one long-lived key for many
   *    stores, so we hand it a fresh `new Uint8Array(savedKey)` each call —
   *    a new buffer with the same bytes — leaving `this.unlockedKey` intact
   *    for subsequent opens. Without this, the second open sees
   *    `encryptionKey.length === 0` and rejects.
   *
   * 2. **OPFS SAH Pool directories are exclusively locked.** sqlite3mc-wasm
   *    builds a pool of handle-locked files inside one OPFS directory and
   *    the lock spans the entire directory. The default (`.aztec-kv`) is
   *    fine for a single store; with multiple coexisting stores we have to
   *    place each one in its own pool dir, otherwise the second store's
   *    `createSyncAccessHandle` rejects with "Access Handles cannot be
   *    created if there is another open Access Handle...". Naming each
   *    pool after the store gives stable cross-session identity (the same
   *    name re-opens the same OPFS files).
   */
  async getStore(name: string): Promise<AztecAsyncKVStore> {
    if (!this.unlockedKey) {
      throw new Error("Vault is locked");
    }
    const cached = this.openStores.get(name);
    if (cached) return cached;
    const keyCopy = new Uint8Array(this.unlockedKey);
    const store = await openEncryptedStore(keyCopy, name, `.aztec-${name}`);
    this.openStores.set(name, store);
    return store;
  }

  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(state: "locked" | "unlocked") {
    for (const l of this.listeners) l(state);
  }
}
