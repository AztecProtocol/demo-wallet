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
