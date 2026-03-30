/**
 * Cookie-based portability for cross-origin iframe embedding.
 *
 * Browser storage (IndexedDB, localStorage) is permanently partitioned by
 * top-level origin for cross-origin iframes. `requestStorageAccess()` only
 * unpartitions **cookies**. We store account secrets, contacts, and capability
 * grants in unpartitioned cookies so the iframe can reconstruct wallet state.
 *
 * SECURITY: All cookie payloads are encrypted with AES-256-GCM using a key
 * derived from a user passphrase via PBKDF2. The server only sees ciphertext.
 *
 * Accounts:     `aztec-wallet-accounts` = base64(salt + iv + ciphertext(JSON))
 * Contacts:     `aztec-wallet-contacts-{N}` = base64(salt + iv + ciphertext(binary))
 * Capabilities: `aztec-wallet-caps-{N}` = base64(salt + iv + ciphertext(JSON))
 *
 * Contacts use binary packing (32-byte raw addresses instead of 66-char hex)
 * and span multiple numbered cookies for practically unbounded storage.
 * Each cookie chunk is independently encrypted.
 *
 * Contact binary format per entry: [32 bytes address] [1 byte alias len] [N bytes alias]
 * ~47 bytes per contact (with 14-char alias) → ~60 contacts per cookie → 600+ with 10 cookies.
 *
 * Capabilities store all per-app authorization entries (grants, __behavior__,
 * __requested__) as JSON, using multi-cookie chunking for large manifests.
 *
 * Attributes: SameSite=None; Secure; Path=/; Max-Age=31536000 (1 year)
 */

import type { AccountType } from "@demo-wallet/shared/core";
import {
  encryptWithPassphrase,
  decryptWithPassphrase,
  uint8ToBase64,
  base64ToUint8,
} from "@aztec/wallet-sdk/crypto";

export interface PortableAccount {
  /** AztecAddress hex string */
  address: `0x${string}`;
  /** Fr secret key as 0x-prefixed hex */
  secretKey: `0x${string}`;
  /** Fr salt as 0x-prefixed hex */
  salt: `0x${string}`;
  /** Signing key (Fq or Buffer) as hex */
  signingKey: string;
  /** Account type */
  type: AccountType;
  /** Human-readable alias */
  alias?: string;
}

const COOKIE_NAME = "aztec-wallet-accounts";
const MAX_AGE = 31536000; // 1 year in seconds

function encryptString(plaintext: string, passphrase: string): Promise<Uint8Array> {
  return encryptWithPassphrase(new TextEncoder().encode(plaintext), passphrase);
}

function decryptString(data: Uint8Array, passphrase: string): Promise<string> {
  return decryptWithPassphrase(data, passphrase).then((b) => new TextDecoder().decode(b));
}

// ─── Public API ───

/**
 * Write portable accounts to the unpartitioned cookie, encrypted with the
 * given passphrase. The server only sees opaque ciphertext.
 */
export async function writeAccountsCookie(
  accounts: PortableAccount[],
  passphrase: string,
): Promise<void> {
  const json = JSON.stringify(accounts);
  const encrypted = await encryptString(json, passphrase);
  const encoded = uint8ToBase64(encrypted);

  const parts = [
    `${COOKIE_NAME}=${encoded}`,
    `Path=/`,
    `Max-Age=${MAX_AGE}`,
    `SameSite=None`,
    `Secure`,
  ];

  document.cookie = parts.join("; ");
}

/**
 * Read and decrypt portable accounts from the cookie.
 * Returns empty array if cookie is missing or decryption fails (wrong passphrase).
 * Throws on wrong passphrase so the caller can prompt again.
 */
export async function readAccountsCookie(
  passphrase: string,
): Promise<PortableAccount[]> {
  const match = document.cookie
    .split("; ")
    .find((c) => c.startsWith(`${COOKIE_NAME}=`));

  if (!match) return [];

  const encoded = match.split("=").slice(1).join("=");
  const data = base64ToUint8(encoded);
  // decryptString throws on wrong passphrase (AES-GCM auth tag mismatch)
  const json = await decryptString(data, passphrase);
  const parsed = JSON.parse(json);
  if (!Array.isArray(parsed)) return [];
  return parsed;
}

/**
 * Check whether the accounts cookie exists (without decrypting).
 */
export function hasAccountsCookie(): boolean {
  return document.cookie
    .split("; ")
    .some((c) => c.startsWith(`${COOKIE_NAME}=`));
}

/**
 * Delete the accounts cookie.
 */
export function clearAccountsCookie(): void {
  document.cookie = `${COOKIE_NAME}=; Path=/; Max-Age=0; SameSite=None; Secure`;
}

// ─── Contacts (binary-packed, multi-cookie) ───

export interface PortableContact {
  /** AztecAddress as raw 32 bytes */
  address: Uint8Array;
  /** Human-readable alias (UTF-8, max 255 bytes) */
  alias: string;
}

const CONTACTS_COOKIE_PREFIX = "aztec-wallet-contacts-";
const ADDRESS_BYTES = 32;
// Max cookie value size after accounting for name + attributes.
// Cookie total limit is ~4096 bytes. Name "aztec-wallet-contacts-NN" is ~26 chars,
// attributes "; Path=/; ..." add ~50 chars. Leave margin → 4000 bytes for the value.
// base64 expands 3:4, and encryption adds 44 bytes (salt+iv+tag).
// So max plaintext per chunk ≈ (4000 / 1.34) - 44 ≈ 2940 bytes.
const MAX_PLAINTEXT_PER_CHUNK = 2900;

/**
 * Pack contacts into a compact binary format.
 * Layout per entry: [32 bytes address] [1 byte alias length] [N bytes alias UTF-8]
 */
function packContacts(contacts: PortableContact[]): Uint8Array {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  let totalLen = 0;
  for (const c of contacts) {
    const aliasBytes = encoder.encode(c.alias);
    if (aliasBytes.length > 255) throw new Error(`Alias too long: ${c.alias}`);
    // address(32) + aliasLen(1) + alias(N)
    const entry = new Uint8Array(ADDRESS_BYTES + 1 + aliasBytes.length);
    entry.set(c.address, 0);
    entry[ADDRESS_BYTES] = aliasBytes.length;
    entry.set(aliasBytes, ADDRESS_BYTES + 1);
    parts.push(entry);
    totalLen += entry.length;
  }
  const result = new Uint8Array(totalLen);
  let offset = 0;
  for (const p of parts) {
    result.set(p, offset);
    offset += p.length;
  }
  return result;
}

/**
 * Unpack contacts from the compact binary format.
 */
function unpackContacts(data: Uint8Array): PortableContact[] {
  const decoder = new TextDecoder();
  const contacts: PortableContact[] = [];
  let offset = 0;
  while (offset < data.length) {
    if (offset + ADDRESS_BYTES + 1 > data.length) break;
    const address = data.slice(offset, offset + ADDRESS_BYTES);
    const aliasLen = data[offset + ADDRESS_BYTES];
    offset += ADDRESS_BYTES + 1;
    if (offset + aliasLen > data.length) break;
    const alias = decoder.decode(data.slice(offset, offset + aliasLen));
    offset += aliasLen;
    contacts.push({ address, alias });
  }
  return contacts;
}

/**
 * Split packed binary into chunks that fit within a single cookie's plaintext budget.
 */
function chunkBytes(data: Uint8Array, maxBytes: number): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < data.length; i += maxBytes) {
    chunks.push(data.slice(i, Math.min(i + maxBytes, data.length)));
  }
  return chunks.length > 0 ? chunks : [new Uint8Array(0)];
}

/**
 * Write contacts to multiple encrypted cookies.
 * Old contact cookies beyond the new count are cleared.
 */
export async function writeContactsCookies(
  contacts: PortableContact[],
  passphrase: string,
): Promise<void> {
  const packed = packContacts(contacts);
  const chunks = chunkBytes(packed, MAX_PLAINTEXT_PER_CHUNK);

  for (let i = 0; i < chunks.length; i++) {
    const encrypted = await encryptWithPassphrase(chunks[i], passphrase);
    const encoded = uint8ToBase64(encrypted);
    document.cookie = [
      `${CONTACTS_COOKIE_PREFIX}${i}=${encoded}`,
      `Path=/`,
      `Max-Age=${MAX_AGE}`,
      `SameSite=None`,
      `Secure`,
    ].join("; ");
  }

  // Clear any leftover cookies from a previous larger set
  for (let i = chunks.length; ; i++) {
    const name = `${CONTACTS_COOKIE_PREFIX}${i}`;
    if (!document.cookie.split("; ").some((c) => c.startsWith(`${name}=`))) break;
    document.cookie = `${name}=; Path=/; Max-Age=0; SameSite=None; Secure`;
  }
}

/**
 * Read and decrypt contacts from all numbered cookies.
 * Throws on wrong passphrase.
 */
export async function readContactsCookies(
  passphrase: string,
): Promise<PortableContact[]> {
  const allCookies = document.cookie.split("; ");
  const chunks: Uint8Array[] = [];

  for (let i = 0; ; i++) {
    const name = `${CONTACTS_COOKIE_PREFIX}${i}`;
    const match = allCookies.find((c) => c.startsWith(`${name}=`));
    if (!match) break;
    const encoded = match.split("=").slice(1).join("=");
    const data = base64ToUint8(encoded);
    chunks.push(await decryptWithPassphrase(data, passphrase));
  }

  if (chunks.length === 0) return [];

  // Concatenate all decrypted chunks
  const totalLen = chunks.reduce((sum, c) => sum + c.length, 0);
  const combined = new Uint8Array(totalLen);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }

  return unpackContacts(combined);
}

/**
 * Check whether any contacts cookies exist (without decrypting).
 */
export function hasContactsCookies(): boolean {
  return document.cookie
    .split("; ")
    .some((c) => c.startsWith(`${CONTACTS_COOKIE_PREFIX}0=`));
}

/**
 * Delete all contacts cookies.
 */
export function clearContactsCookies(): void {
  for (let i = 0; ; i++) {
    const name = `${CONTACTS_COOKIE_PREFIX}${i}`;
    if (!document.cookie.split("; ").some((c) => c.startsWith(`${name}=`))) break;
    document.cookie = `${name}=; Path=/; Max-Age=0; SameSite=None; Secure`;
  }
}

// ─── Capabilities (JSON, multi-cookie) ───

/**
 * Portable representation of all authorization data for one app.
 * Carries capability grants, behavior settings, and requested-key history.
 */
export interface PortableAppCapabilities {
  /** The application identifier (e.g. origin URL) */
  appId: string;
  /**
   * Raw authorization entries keyed by storageKey (without the appId: prefix).
   * Includes regular grant keys, __behavior__, and __requested__.
   * Values are the JSON-parsed objects stored in WalletDB.authorizations.
   */
  entries: Record<string, unknown>;
}

const CAPS_COOKIE_PREFIX = "aztec-wallet-caps-";

/**
 * Write all apps' capability grants to encrypted multi-cookie storage.
 * Old capability cookies beyond the new count are cleared.
 */
export async function writeCapabilitiesCookies(
  apps: PortableAppCapabilities[],
  passphrase: string,
): Promise<void> {
  const json = JSON.stringify(apps);
  const plaintext = new TextEncoder().encode(json);
  const chunks = chunkBytes(plaintext, MAX_PLAINTEXT_PER_CHUNK);

  for (let i = 0; i < chunks.length; i++) {
    const encrypted = await encryptWithPassphrase(chunks[i], passphrase);
    const encoded = uint8ToBase64(encrypted);
    document.cookie = [
      `${CAPS_COOKIE_PREFIX}${i}=${encoded}`,
      `Path=/`,
      `Max-Age=${MAX_AGE}`,
      `SameSite=None`,
      `Secure`,
    ].join("; ");
  }

  // Clear leftover cookies from a previous larger set
  for (let i = chunks.length; ; i++) {
    const name = `${CAPS_COOKIE_PREFIX}${i}`;
    if (!document.cookie.split("; ").some((c) => c.startsWith(`${name}=`))) break;
    document.cookie = `${name}=; Path=/; Max-Age=0; SameSite=None; Secure`;
  }
}

/**
 * Read and decrypt capability grants from all numbered cookies.
 * Throws on wrong passphrase.
 */
export async function readCapabilitiesCookies(
  passphrase: string,
): Promise<PortableAppCapabilities[]> {
  const allCookies = document.cookie.split("; ");
  const chunks: Uint8Array[] = [];

  for (let i = 0; ; i++) {
    const name = `${CAPS_COOKIE_PREFIX}${i}`;
    const match = allCookies.find((c) => c.startsWith(`${name}=`));
    if (!match) break;
    const encoded = match.split("=").slice(1).join("=");
    const data = base64ToUint8(encoded);
    chunks.push(await decryptWithPassphrase(data, passphrase));
  }

  if (chunks.length === 0) return [];

  // Concatenate all decrypted chunks
  const totalLen = chunks.reduce((sum, c) => sum + c.length, 0);
  const combined = new Uint8Array(totalLen);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }

  const json = new TextDecoder().decode(combined);
  const parsed = JSON.parse(json);
  if (!Array.isArray(parsed)) return [];
  return parsed;
}

/**
 * Check whether any capabilities cookies exist (without decrypting).
 */
export function hasCapabilitiesCookies(): boolean {
  return document.cookie
    .split("; ")
    .some((c) => c.startsWith(`${CAPS_COOKIE_PREFIX}0=`));
}

/**
 * Delete all capabilities cookies.
 */
export function clearCapabilitiesCookies(): void {
  for (let i = 0; ; i++) {
    const name = `${CAPS_COOKIE_PREFIX}${i}`;
    if (!document.cookie.split("; ").some((c) => c.startsWith(`${name}=`))) break;
    document.cookie = `${name}=; Path=/; Max-Age=0; SameSite=None; Secure`;
  }
}
