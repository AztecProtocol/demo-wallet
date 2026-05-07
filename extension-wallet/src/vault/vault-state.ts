import {
  deriveKey,
  generateSalt,
  makeProbe,
  verifyProbe,
  DEFAULT_KDF_PARAMS,
} from "./kdf";
import { hasVaultMeta, readVaultMeta, writeVaultMeta } from "./vault-meta";

type Listener = (state: "locked" | "unlocked") => void;

export class VaultState {
  private unlockedKey: Uint8Array | null = null;
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
    const vaultProbe = await makeProbe(key);
    await writeVaultMeta({ kdfSalt, kdfParams, vaultProbe });
    this.unlockedKey = key;
    this.notify("unlocked");
  }

  /** Try to unlock with a password. Returns true on success. */
  async unlock(password: string): Promise<boolean> {
    const meta = await readVaultMeta();
    if (!meta) return false;
    const key = await deriveKey(password, meta.kdfSalt, meta.kdfParams);
    if (!(await verifyProbe(meta.vaultProbe, key))) return false;
    this.unlockedKey = key;
    this.notify("unlocked");
    return true;
  }

  lock(): void {
    if (!this.unlockedKey) return;
    this.unlockedKey.fill(0);
    this.unlockedKey = null;
    this.notify("locked");
  }

  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(state: "locked" | "unlocked") {
    for (const l of this.listeners) l(state);
  }
}
