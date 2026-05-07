import { createStore } from "@aztec/kv-store/indexeddb";
import { createLogger } from "@aztec/aztec.js/log";
import type { KdfParams, VaultProbe } from "./kdf";

const STORE_NAME = "vault-meta";
const META_KEY = "v1";

export interface VaultMeta {
  kdfSalt: Uint8Array;
  kdfParams: KdfParams;
  vaultProbe: VaultProbe;
}

interface SerializedMeta {
  kdfSalt: number[];
  kdfParams: KdfParams;
  vaultProbe: { iv: number[]; ciphertext: number[] };
}

let cachedStore: Awaited<ReturnType<typeof createStore>> | null = null;

async function getMetaMap() {
  if (!cachedStore) {
    cachedStore = await createStore(
      STORE_NAME,
      { dataDirectory: STORE_NAME, dataStoreMapSizeKb: 1024 },
      1,
      createLogger("vault-meta"),
    );
  }
  return cachedStore.openMap<string, string>("meta");
}

export async function readVaultMeta(): Promise<VaultMeta | null> {
  const map = await getMetaMap();
  const raw = await map.getAsync(META_KEY);
  if (!raw) return null;
  const parsed = JSON.parse(raw) as SerializedMeta;
  return {
    kdfSalt: Uint8Array.from(parsed.kdfSalt),
    kdfParams: parsed.kdfParams,
    vaultProbe: {
      iv: Uint8Array.from(parsed.vaultProbe.iv),
      ciphertext: Uint8Array.from(parsed.vaultProbe.ciphertext),
    },
  };
}

export async function writeVaultMeta(meta: VaultMeta): Promise<void> {
  const map = await getMetaMap();
  const serialized: SerializedMeta = {
    kdfSalt: Array.from(meta.kdfSalt),
    kdfParams: meta.kdfParams,
    vaultProbe: {
      iv: Array.from(meta.vaultProbe.iv),
      ciphertext: Array.from(meta.vaultProbe.ciphertext),
    },
  };
  await map.set(META_KEY, JSON.stringify(serialized));
}

export async function hasVaultMeta(): Promise<boolean> {
  return (await readVaultMeta()) !== null;
}
