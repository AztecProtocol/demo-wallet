/**
 * Browser wallet service — web-flavor wrapper around the host-agnostic
 * session manager in `@demo-wallet/shared/core`.
 *
 * The host-agnostic core (PXE per chainId-version, wallet pair per appId,
 * RUNNING_SESSIONS map) lives in `shared/wallet/session/`. This file layers
 * the web-only cookie-sync glue on top:
 *   - cookie-passphrase state and accessors
 *   - bootstrapping accounts/contacts/capabilities from encrypted cookies
 *   - syncing wallet state back to cookies on `wallet-update` events
 *   - iframe-vs-standalone behavior gates via the `IS_IFRAME` flag
 *
 * Call sites that previously imported `getOrCreateSession` directly should
 * use `getOrCreateSessionWithCookieSync` instead — same signature plus the
 * cookie-sync side effects wired in.
 */

import { type ChainInfo } from "@aztec/aztec.js/account";
import { Fr } from "@aztec/aztec.js/fields";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { createLogger } from "@aztec/aztec.js/log";
import {
  ExternalWallet,
  InternalWallet,
  WalletDB,
  getOrCreateSession,
  getRunningSessionIds,
  getSharedResources,
} from "@demo-wallet/shared/core";
import { type PXE } from "@aztec/pxe/client/lazy";
import {
  writeAccountsCookie,
  readAccountsCookie,
  writeContactsCookies,
  readContactsCookies,
  writeCapabilitiesCookies,
  readCapabilitiesCookies,
  type PortableAccount,
  type PortableContact,
} from "./sync-cookies.ts";

// Re-export the lifted host-agnostic API so existing callers can keep
// importing from this module.
export { getOrCreateSession, getRunningSessionIds, getSharedResources };

const IS_IFRAME = typeof window !== "undefined" && window.self !== window.top;

// ─── Targeted cookie sync ───
// Each cookie is synced only when the relevant data changes, not on every
// interaction update. Debounced to coalesce rapid successive changes.

function debouncedSync(fn: (db: WalletDB) => Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return (db: WalletDB) => {
    if (timer) return;
    timer = setTimeout(async () => {
      timer = null;
      if (_cookiePassphrase) {
        await fn(db);
      }
    }, 500);
  };
}

const scheduleAccountSync = debouncedSync((db) => syncAccountsToCookie(db));
const scheduleContactSync = debouncedSync((db) => syncContactsToCookie(db));
const scheduleCapabilitySync = debouncedSync((db) => syncCapabilitiesToCookie(db));

// ─── Passphrase management ───
// Held in memory only — never persisted. Must be set before cookie operations.
let _cookiePassphrase: string | null = null;

/** Set the passphrase used to encrypt/decrypt the accounts cookie. */
export function setCookiePassphrase(passphrase: string): void {
  _cookiePassphrase = passphrase;
}

/** Returns whether a cookie passphrase has been set for this session. */
export function hasCookiePassphrase(): boolean {
  return _cookiePassphrase !== null;
}

// Tracks one-time cookie bootstrap per session id so that the first call to
// `getOrCreateSessionWithCookieSync` for a given `chainId-version` runs the
// bootstrap exactly once. Subsequent calls await the same promise.
const cookieBootstrapBySession = new Map<string, Promise<void>>();

/**
 * Web-flavor wrapper around `getOrCreateSession`. Same signature, plus:
 *   - schedules the appropriate cookie sync when `wallet-update` fires
 *   - filters out internal `capabilityChange` events from the UI callback
 *   - in iframe mode, bootstraps accounts/contacts/capabilities from cookies
 *     once per session before the first wallet pair is returned
 *   - in standalone mode, runs the initial capability bootstrap-and-resync
 *     once per session before the first wallet pair is returned
 */
export async function getOrCreateSessionWithCookieSync(
  chainInfo: ChainInfo,
  appId: string,
  onWalletEvent: (eventType: string, detail: unknown) => void,
): Promise<{ external: ExternalWallet; internal: InternalWallet }> {
  // Captured after the lifted getOrCreateSession resolves. Events can only
  // fire after wallet construction, which can only happen after the session's
  // shared resources resolve, so by the time `wrappedOnWalletEvent` is invoked
  // this reference is guaranteed to be set.
  let sessionDb: WalletDB | null = null;

  const wrappedOnWalletEvent = (eventType: string, detail: unknown) => {
    if (eventType === "wallet-update") {
      // Sync only the relevant cookie based on the interaction type.
      let type: string | undefined;
      try {
        type = JSON.parse(detail as string)?.type;
      } catch {
        /* ignore parse errors */
      }

      if (sessionDb) {
        if (!IS_IFRAME && (type === "createAccount" || type === "deployAccount")) {
          scheduleAccountSync(sessionDb);
        } else if (!IS_IFRAME && type === "registerSender") {
          scheduleContactSync(sessionDb);
        } else if (type === "requestCapabilities" || type === "capabilityChange") {
          scheduleCapabilitySync(sessionDb);
        }
      }

      // Don't forward internal-only events to the UI.
      if (type === "capabilityChange") return;
    }
    onWalletEvent(eventType, detail);
  };

  const pair = await getOrCreateSession(chainInfo, appId, wrappedOnWalletEvent);
  const resources = await getSharedResources(chainInfo);
  sessionDb = resources.db;

  // ─── One-shot per-session cookie bootstrap ───
  // The original `wallet-service.ts` ran this inline inside the lifted `pxeInit`
  // block, but the lifted module no longer knows about cookies. Run it here on
  // the first call per session id, gated on the passphrase being set.
  if (_cookiePassphrase) {
    const sessionId = `${chainInfo.chainId.toNumber()}-${chainInfo.version.toNumber()}`;
    let bootstrap = cookieBootstrapBySession.get(sessionId);
    if (!bootstrap) {
      bootstrap = (async () => {
        const { db, pxe } = resources;

        // Import capabilities from cookie (full overwrite: cookie is authoritative).
        await bootstrapCapabilitiesFromCookie(db);

        if (IS_IFRAME) {
          // Iframe: import accounts and contacts from cookies into PXE.
          // Must be serialized to avoid concurrent PXE operations on the same
          // IndexedDB (IDB transactions auto-close on browser, causing
          // "object not usable" errors).
          await bootstrapAccountsFromCookie(chainInfo, pair.internal);
          await bootstrapContactsFromCookie(db, pxe);
        } else {
          // Standalone: accounts and contacts are the source of truth — push
          // the current state to the cookie so the iframe can pick it up.
          await syncAccountsToCookie(db);
          await syncContactsToCookie(db);
        }

        // Export capabilities to cookie (includes both local + newly imported).
        await syncCapabilitiesToCookie(db);
      })();
      cookieBootstrapBySession.set(sessionId, bootstrap);
    }
    await bootstrap;
  }

  return pair;
}

/**
 * Import accounts from the encrypted cookie into the session's WalletDB
 * and register them with PXE (via InternalWallet.getAccountManager).
 * Used by the iframe to bootstrap accounts from the standalone wallet.
 * Requires passphrase to have been set via setCookiePassphrase().
 * Skips accounts that already exist in the DB.
 *
 * @param wallet - An InternalWallet instance used to register accounts with PXE.
 */
export async function bootstrapAccountsFromCookie(
  chainInfo: ChainInfo,
  wallet: InternalWallet,
): Promise<number> {
  const log = createLogger("wallet:cookie");

  if (!_cookiePassphrase) {
    log.warn("No passphrase set — cannot read encrypted cookie");
    return 0;
  }

  const portableAccounts = await readAccountsCookie(_cookiePassphrase);

  if (portableAccounts.length === 0) {
    log.info("No accounts found in cookie");
    return 0;
  }

  const { db } = await getSharedResources(chainInfo);
  const existingAccounts = await db.listAccounts();
  const existingAddresses = new Set(existingAccounts.map((a) => a.item.toString()));

  let imported = 0;
  for (const portable of portableAccounts) {
    const secretKey = Fr.fromString(portable.secretKey);
    const salt = Fr.fromString(portable.salt);
    const signingKey = Buffer.from(portable.signingKey, "hex");

    const address = AztecAddress.fromString(portable.address);
    if (!existingAddresses.has(portable.address)) {
      await db.storeAccount(address, {
        type: portable.type,
        secretKey,
        salt,
        signingKey,
        alias: portable.alias,
      });
      imported++;
      log.info(`Imported account ${portable.alias ?? portable.address} from cookie`);
    }

    // Sync deployed state from cookie
    if (portable.deployed) {
      await db.markAccountDeployed(address);
    }

    // Register with PXE via the wallet's getAccountManager (idempotent).
    await wallet.getAccountManager(portable.type, secretKey, salt, signingKey);
    log.info(`Registered account ${portable.alias ?? portable.address} with PXE`);
  }

  log.info(
    `Bootstrapped ${imported} new account(s) from cookie (${portableAccounts.length} total in cookie)`,
  );
  return imported;
}

/**
 * Import contacts from the encrypted cookies into the session's WalletDB
 * and register them as senders with PXE.
 * Bypasses InternalWallet.registerSender to avoid emitting interaction events
 * for each bootstrapped contact (which would clutter the interaction history).
 */
async function bootstrapContactsFromCookie(db: WalletDB, pxe: PXE): Promise<number> {
  const log = createLogger("wallet:cookie");

  if (!_cookiePassphrase) {
    log.warn("No passphrase set — cannot read contacts cookies");
    return 0;
  }

  const portableContacts = await readContactsCookies(_cookiePassphrase);
  if (portableContacts.length === 0) {
    log.info("No contacts found in cookies");
    return 0;
  }

  let imported = 0;
  for (const contact of portableContacts) {
    const address = AztecAddress.fromBuffer(Buffer.from(contact.address));
    await db.storeSender(address, contact.alias);
    await pxe.registerSender(address);
    imported++;
  }

  log.info(`Bootstrapped ${imported} contact(s) from cookies`);
  return imported;
}

/**
 * Read all accounts from WalletDB and write them to the encrypted cookie.
 * Called after PXE init and on wallet-update events to keep the cookie in sync.
 * No-op if passphrase is not set.
 */
async function syncAccountsToCookie(db: WalletDB): Promise<void> {
  if (!_cookiePassphrase) return;

  try {
    const aliasedAccounts = await db.listAccounts();
    const portableAccounts: PortableAccount[] = [];

    for (const { alias, item: address } of aliasedAccounts) {
      const account = await db.retrieveAccount(address);
      portableAccounts.push({
        address: address.toString(),
        secretKey: account.secretKey.toString(),
        salt: account.salt.toString(),
        signingKey: Buffer.from(account.signingKey).toString("hex"),
        type: account.type,
        alias,
        deployed: account.deployed,
      });
    }

    await writeAccountsCookie(portableAccounts, _cookiePassphrase);
    createLogger("wallet:cookie").info(
      `Synced ${portableAccounts.length} account(s) to encrypted cookie`,
    );
  } catch (e) {
    createLogger("wallet:cookie").warn(`Failed to sync accounts to cookie: ${e}`);
  }
}

/**
 * Read all contacts (senders) from WalletDB and write them to encrypted cookies.
 * Called alongside syncAccountsToCookie. No-op if passphrase is not set.
 */
async function syncContactsToCookie(db: WalletDB): Promise<void> {
  if (!_cookiePassphrase) return;

  try {
    const senders = await db.listSenders();
    const portableContacts: PortableContact[] = senders.map(({ alias, item: address }) => ({
      address: address.toBuffer(),
      alias: alias.replace(/^senders:/, ""),
    }));

    await writeContactsCookies(portableContacts, _cookiePassphrase);
    createLogger("wallet:cookie").info(
      `Synced ${portableContacts.length} contact(s) to encrypted cookies`,
    );
  } catch (e) {
    createLogger("wallet:cookie").warn(`Failed to sync contacts to cookie: ${e}`);
  }
}

/**
 * Export all capability grants from WalletDB and write them to encrypted cookies.
 * Called alongside syncAccountsToCookie/syncContactsToCookie.
 * Standalone mode only — iframe never writes capabilities cookies.
 */
async function syncCapabilitiesToCookie(db: WalletDB): Promise<void> {
  if (!_cookiePassphrase) return;

  try {
    const apps = await db.exportAllAuthorizations();
    await writeCapabilitiesCookies(apps, _cookiePassphrase);
    createLogger("wallet:cookie").info(
      `Synced capabilities for ${apps.length} app(s) to encrypted cookies`,
    );
  } catch (e) {
    createLogger("wallet:cookie").warn(`Failed to sync capabilities to cookie: ${e}`);
  }
}

/**
 * Import capability grants from the encrypted cookies into the session's WalletDB.
 * Used by the iframe to bootstrap dApp authorization state from the standalone wallet.
 */
async function bootstrapCapabilitiesFromCookie(db: WalletDB): Promise<number> {
  const log = createLogger("wallet:cookie");

  if (!_cookiePassphrase) {
    log.warn("No passphrase set — cannot read capabilities cookies");
    return 0;
  }

  const apps = await readCapabilitiesCookies(_cookiePassphrase);
  if (apps.length === 0) {
    log.info("No capabilities found in cookies");
    return 0;
  }

  const imported = await db.importAllAuthorizations(apps);
  log.info(
    `Bootstrapped capabilities for ${apps.length} app(s) (${imported} entries) from cookies`,
  );
  return imported;
}
