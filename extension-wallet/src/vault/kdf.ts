import { argon2id } from "@noble/hashes/argon2";

export interface KdfParams {
  /** Memory cost in KiB. */
  m: number;
  /** Iterations. */
  t: number;
  /** Parallelism. */
  p: number;
}

/** Conservative defaults sized to <500ms on a 2024-era laptop. */
export const DEFAULT_KDF_PARAMS: KdfParams = { m: 64 * 1024, t: 3, p: 1 };

const KEY_LEN = 32;
const SALT_LEN = 16;
const PROBE_PLAINTEXT = new TextEncoder().encode("aztec-extension-wallet/probe/v1");

export function generateSalt(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(SALT_LEN));
}

export async function deriveKey(
  password: string,
  salt: Uint8Array,
  params: KdfParams,
): Promise<Uint8Array> {
  return argon2id(new TextEncoder().encode(password), salt, {
    m: params.m,
    t: params.t,
    p: params.p,
    dkLen: KEY_LEN,
  });
}

export interface VaultProbe {
  iv: Uint8Array;
  ciphertext: Uint8Array;
}

async function importAesKey(rawKey: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", rawKey, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function makeProbe(rawKey: Uint8Array): Promise<VaultProbe> {
  const key = await importAesKey(rawKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, PROBE_PLAINTEXT),
  );
  return { iv, ciphertext };
}

export async function verifyProbe(probe: VaultProbe, rawKey: Uint8Array): Promise<boolean> {
  const key = await importAesKey(rawKey);
  try {
    const plain = new Uint8Array(
      await crypto.subtle.decrypt({ name: "AES-GCM", iv: probe.iv }, key, probe.ciphertext),
    );
    if (plain.length !== PROBE_PLAINTEXT.length) return false;
    for (let i = 0; i < plain.length; i++) {
      if (plain[i] !== PROBE_PLAINTEXT[i]) return false;
    }
    return true;
  } catch {
    return false;
  }
}
