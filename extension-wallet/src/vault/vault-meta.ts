import type { KdfParams } from "./kdf";

/**
 * Vault metadata persists unencrypted because we need the salt + KDF params
 * to re-derive the encryption key from the user's password on each unlock.
 * Neither needs to be secret: the salt's only purpose is defeating bulk
 * amortization across vaults (so an attacker can't precompute one rainbow
 * table that cracks many users), and the KDF tuning params have to be known
 * to reproduce the same key on unlock but don't help an attacker guess
 * faster.
 *
 * **Why proxy through the SW**: Chrome's offscreen documents are documented
 * to have `chrome.storage` access, but in practice some Chromium builds don't
 * expose it (we've observed this in the wild: `typeof chrome.storage` is
 * `"undefined"` even with the `storage` permission declared). The SW always
 * has it, so when we detect we're in a context without `chrome.storage` we
 * round-trip through the SW. Contexts that do have it (SW, expanded view)
 * use it directly and avoid the extra hop.
 */

const STORAGE_KEY = "vault-meta";

export const VAULT_META_READ = "vault-meta:read";
export const VAULT_META_WRITE = "vault-meta:write";

export interface VaultMeta {
  kdfSalt: Uint8Array;
  kdfParams: KdfParams;
}

interface SerializedMeta {
  /** chrome.storage.local can't carry Uint8Array directly; serialize as number[]. */
  kdfSalt: number[];
  kdfParams: KdfParams;
}

// Flat reply shapes (rather than discriminated unions) because the workspace
// `tsconfig.json` overrides `strict: false`, and without `strictNullChecks`
// TS doesn't reliably narrow `if (reply.ok)` on a tagged union.
interface ProxyReadReply {
  ok: boolean;
  meta?: SerializedMeta | null;
  error?: string;
}

interface ProxyWriteReply {
  ok: boolean;
  error?: string;
}

function hasDirectStorage(): boolean {
  return (
    typeof chrome !== "undefined" &&
    typeof chrome.storage !== "undefined" &&
    typeof chrome.storage.local !== "undefined"
  );
}

async function readSerialized(): Promise<SerializedMeta | undefined> {
  if (hasDirectStorage()) {
    const result = await chrome.storage.local.get(STORAGE_KEY);
    return result[STORAGE_KEY] as SerializedMeta | undefined;
  }
  const reply = (await chrome.runtime.sendMessage({
    type: VAULT_META_READ,
  })) as ProxyReadReply | undefined;
  if (!reply) throw new Error("Vault meta proxy: no response from background");
  if (!reply.ok) throw new Error(reply.error ?? "Unknown vault-meta proxy error");
  return reply.meta ?? undefined;
}

async function writeSerialized(meta: SerializedMeta): Promise<void> {
  if (hasDirectStorage()) {
    await chrome.storage.local.set({ [STORAGE_KEY]: meta });
    return;
  }
  const reply = (await chrome.runtime.sendMessage({
    type: VAULT_META_WRITE,
    meta,
  })) as ProxyWriteReply | undefined;
  if (!reply) throw new Error("Vault meta proxy: no response from background");
  if (!reply.ok) throw new Error(reply.error ?? "Unknown vault-meta proxy error");
}

export async function hasVaultMeta(): Promise<boolean> {
  return (await readSerialized()) !== undefined;
}

export async function readVaultMeta(): Promise<VaultMeta | null> {
  const raw = await readSerialized();
  if (!raw) return null;
  return {
    kdfSalt: Uint8Array.from(raw.kdfSalt),
    kdfParams: raw.kdfParams,
  };
}

export async function writeVaultMeta(meta: VaultMeta): Promise<void> {
  await writeSerialized({
    kdfSalt: Array.from(meta.kdfSalt),
    kdfParams: meta.kdfParams,
  });
}

/**
 * SW-side handler for proxied vault-meta reads/writes from contexts that lack
 * `chrome.storage` (e.g. offscreen documents on certain Chromium builds).
 * Returns true to keep the message channel open for the async sendResponse.
 */
export function handleVaultMetaProxyMessage(
  msg: unknown,
  sendResponse: (reply: ProxyReadReply | ProxyWriteReply) => void,
): boolean {
  const m = msg as { type?: string; meta?: unknown };
  if (m.type === VAULT_META_READ) {
    chrome.storage.local.get(STORAGE_KEY).then(
      (result) =>
        sendResponse({
          ok: true,
          meta: (result[STORAGE_KEY] as SerializedMeta | undefined) ?? null,
        }),
      (err: Error) => sendResponse({ ok: false, error: err.message }),
    );
    return true;
  }
  if (m.type === VAULT_META_WRITE) {
    if (!m.meta || typeof m.meta !== "object") {
      sendResponse({ ok: false, error: "vault-meta:write missing payload" });
      return false;
    }
    chrome.storage.local.set({ [STORAGE_KEY]: m.meta }).then(
      () => sendResponse({ ok: true }),
      (err: Error) => sendResponse({ ok: false, error: err.message }),
    );
    return true;
  }
  return false;
}
