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
 * Accounts:     `aztec-wallet-accounts`    = base64(salt + iv + ciphertext(JSON))
 * Contacts:     `aztec-wallet-contacts-{N}` = chunked base64(salt + iv + ciphertext(gzip(binary)))
 * Capabilities: `aztec-wallet-caps-{N}`    = chunked base64(salt + iv + ciphertext(gzip(JSON)))
 *
 * Contacts use binary packing (32-byte raw addresses instead of 66-char hex).
 * Contact binary format per entry: [32 bytes address] [1 byte alias len] [N bytes alias].
 *
 * Capabilities store all per-app authorization entries (grants, __behavior__,
 * __requested__) as JSON.
 *
 * For the multi-cookie formats (contacts, caps) we compress the plaintext with
 * gzip, encrypt the whole payload once (one PBKDF2 derivation + one salt/iv/tag),
 * then split the resulting base64 ciphertext across sequentially-numbered
 * cookies. This is dramatically smaller than encrypting each chunk separately.
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
  /** Whether the account has been deployed on-chain */
  deployed?: boolean;
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
export async function readAccountsCookie(passphrase: string): Promise<PortableAccount[]> {
  const match = document.cookie.split("; ").find((c) => c.startsWith(`${COOKIE_NAME}=`));

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
  return document.cookie.split("; ").some((c) => c.startsWith(`${COOKIE_NAME}=`));
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
// Cookie total limit is ~4096 bytes. Name + attributes consume ~80 chars;
// leave margin → ~4000 bytes for the value.
const MAX_BASE64_PER_CHUNK = 4000;

// ─── Compression + chunked-ciphertext helpers ───

async function gzipCompress(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gzipDecompress(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function chunkString(s: string, maxChars: number): string[] {
  if (s.length === 0) return [""];
  const chunks: string[] = [];
  for (let i = 0; i < s.length; i += maxChars) {
    chunks.push(s.slice(i, i + maxChars));
  }
  return chunks;
}

function readChunkedCookieValue(prefix: string): string | undefined {
  const allCookies = document.cookie.split("; ");
  let result = "";
  let found = false;
  for (let i = 0; ; i++) {
    const name = `${prefix}${i}`;
    const match = allCookies.find((c) => c.startsWith(`${name}=`));
    if (!match) break;
    found = true;
    result += match.split("=").slice(1).join("=");
  }
  return found ? result : undefined;
}

function clearChunkedCookies(prefix: string): void {
  for (let i = 0; ; i++) {
    const name = `${prefix}${i}`;
    if (!document.cookie.split("; ").some((c) => c.startsWith(`${name}=`))) break;
    document.cookie = `${name}=; Path=/; Max-Age=0; SameSite=None; Secure`;
  }
}

/**
 * Compress + encrypt + chunk a binary payload across numbered cookies.
 * Returns the number of chunks written.
 */
async function writeChunkedCookies(
  prefix: string,
  plaintext: Uint8Array,
  passphrase: string,
): Promise<number> {
  const compressed = await gzipCompress(plaintext);
  const encrypted = await encryptWithPassphrase(compressed, passphrase);
  const encoded = uint8ToBase64(encrypted);
  const chunks = chunkString(encoded, MAX_BASE64_PER_CHUNK);

  for (let i = 0; i < chunks.length; i++) {
    document.cookie = [
      `${prefix}${i}=${chunks[i]}`,
      `Path=/`,
      `Max-Age=${MAX_AGE}`,
      `SameSite=None`,
      `Secure`,
    ].join("; ");
  }

  for (let i = chunks.length; ; i++) {
    const name = `${prefix}${i}`;
    if (!document.cookie.split("; ").some((c) => c.startsWith(`${name}=`))) break;
    document.cookie = `${name}=; Path=/; Max-Age=0; SameSite=None; Secure`;
  }

  return chunks.length;
}

/**
 * Read + decrypt + decompress a chunked cookie payload.
 * Returns undefined if no cookies with this prefix exist.
 * Throws on wrong passphrase (AES-GCM auth tag mismatch).
 */
async function readChunkedCookies(
  prefix: string,
  passphrase: string,
): Promise<Uint8Array | undefined> {
  const encoded = readChunkedCookieValue(prefix);
  if (encoded === undefined) return undefined;
  const encrypted = base64ToUint8(encoded);
  const compressed = await decryptWithPassphrase(encrypted, passphrase);
  return gzipDecompress(compressed);
}

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
 * Write contacts to multiple encrypted cookies.
 * Old contact cookies beyond the new count are cleared.
 */
export async function writeContactsCookies(
  contacts: PortableContact[],
  passphrase: string,
): Promise<void> {
  const packed = packContacts(contacts);
  await writeChunkedCookies(CONTACTS_COOKIE_PREFIX, packed, passphrase);
}

/**
 * Read and decrypt contacts from all numbered cookies.
 * Throws on wrong passphrase.
 */
export async function readContactsCookies(passphrase: string): Promise<PortableContact[]> {
  const data = await readChunkedCookies(CONTACTS_COOKIE_PREFIX, passphrase);
  if (!data) return [];
  return unpackContacts(data);
}

/**
 * Check whether any contacts cookies exist (without decrypting).
 */
export function hasContactsCookies(): boolean {
  return document.cookie.split("; ").some((c) => c.startsWith(`${CONTACTS_COOKIE_PREFIX}0=`));
}

/**
 * Delete all contacts cookies.
 */
export function clearContactsCookies(): void {
  clearChunkedCookies(CONTACTS_COOKIE_PREFIX);
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
 */
export async function writeCapabilitiesCookies(
  apps: PortableAppCapabilities[],
  passphrase: string,
): Promise<void> {
  const json = JSON.stringify(apps);
  const plaintext = new TextEncoder().encode(json);
  await writeChunkedCookies(CAPS_COOKIE_PREFIX, plaintext, passphrase);
}

/**
 * Read and decrypt capability grants from all numbered cookies.
 * Throws on wrong passphrase.
 */
export async function readCapabilitiesCookies(
  passphrase: string,
): Promise<PortableAppCapabilities[]> {
  const data = await readChunkedCookies(CAPS_COOKIE_PREFIX, passphrase);
  if (!data) return [];
  const parsed = JSON.parse(new TextDecoder().decode(data));
  return Array.isArray(parsed) ? parsed : [];
}

/**
 * Check whether any capabilities cookies exist (without decrypting).
 */
export function hasCapabilitiesCookies(): boolean {
  return document.cookie.split("; ").some((c) => c.startsWith(`${CAPS_COOKIE_PREFIX}0=`));
}

/**
 * Delete all capabilities cookies.
 */
export function clearCapabilitiesCookies(): void {
  clearChunkedCookies(CAPS_COOKIE_PREFIX);
}
