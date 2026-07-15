/**
 * Browser wallet service — the browser equivalent of wallet-worker.ts.
 *
 * Manages PXE sessions indexed by `chainId-version`. Each session has one
 * shared PXE instance (critical: multiple PXE instances sharing the same
 * IndexedDB store cause Map/storage desync) plus per-appId wallet pairs.
 *
 * Key differences from Electron wallet-worker.ts:
 * - Uses @aztec/pxe/client/lazy (WASM prover, lazy artifact loading)
 * - Uses @aztec/kv-store IndexedDB backend instead of LMDB
 * - Runs in the main browser thread (no worker thread / MessagePortMain)
 * - Logger uses createLogger directly (no proxy logger needed)
 */

import { createAztecNodeClient, type AztecNode } from "@aztec/aztec.js/node";
import { type ChainInfo } from "@aztec/aztec.js/account";
import { Fr } from "@aztec/aztec.js/fields";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { createLogger } from "@aztec/aztec.js/log";
import { promiseWithResolvers, type PromiseWithResolvers } from "@aztec/foundation/promise";
import { jsonStringify } from "@aztec/foundation/json-rpc";
import {
  ExternalWallet,
  InternalWallet,
  WalletDB,
  type AuthorizationRequest,
  type AuthorizationResponse,
  type HandshakeRelayResponse,
  getNetworkByChainId,
} from "@demo-wallet/shared/core";
import {
  createPXE,
  getPXEConfig,
  type PXE,
  type PXEConfig,
  type PXECreationOptions,
} from "@aztec/pxe/client/lazy";
import { createInteractiveHandshakeResolver, RecipientSignatureSchema } from "@aztec/wallet-sdk/delivery";
import { AztecSQLiteOPFSStore } from "@aztec/kv-store/sqlite-opfs";
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

const IS_IFRAME = typeof window !== "undefined" && window.self !== window.top;

type SessionData = {
  sharedResources: Promise<{
    pxe: PXE;
    node: AztecNode;
    db: WalletDB;
    pendingAuthorizations: Map<
      string,
      {
        promise: PromiseWithResolvers<AuthorizationResponse>;
        request: AuthorizationRequest;
      }
    >;
    pendingHandshakeRelays: Map<string, PromiseWithResolvers<HandshakeRelayResponse>>;
  }>;
  /** One-time account/contact bootstrap from cookies. Runs once per session. */
  bootstrapDone: Promise<void> | null;
  wallets: Map<string, Promise<{ external: ExternalWallet; internal: InternalWallet }>>;
};

const RUNNING_SESSIONS = new Map<string, SessionData>();

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

export async function getOrCreateSession(
  chainInfo: ChainInfo,
  appId: string,
  onWalletEvent: (eventType: string, detail: unknown) => void,
): Promise<{ external: ExternalWallet; internal: InternalWallet }> {
  const network = getNetworkByChainId(chainInfo.chainId.toNumber(), chainInfo.version.toNumber());
  if (!network) {
    throw new Error(
      `Unknown network: chainId=${chainInfo.chainId.toNumber()}, version=${chainInfo.version.toNumber()}`,
    );
  }

  const node = createAztecNodeClient(network.nodeUrl!);

  // Auto-detect version if 0
  if (chainInfo.version.equals(new Fr(0))) {
    const { rollupVersion } = await node.getNodeInfo();
    chainInfo = { ...chainInfo, version: new Fr(rollupVersion) };
  }

  const sessionId = `${chainInfo.chainId.toNumber()}-${chainInfo.version.toNumber()}`;
  let session = RUNNING_SESSIONS.get(sessionId);

  if (!session) {
    const log = createLogger("wallet:session");
    log.info(`[PXE-INIT] Creating NEW session with shared PXE instance for sessionId=${sessionId}`);

    const pxeInit = (async () => {
      const l1Contracts = await node.getL1ContractAddresses();
      const rollupAddress = l1Contracts.rollupAddress;

      const configOverrides: Partial<PXEConfig> = {
        proverEnabled: true,
      };

      // SQLite-on-OPFS via the SAH Pool VFS. The SAH Pool holds an exclusive
      // lock on its directory, so each store gets its own poolDirectory scoped
      // by rollup address.
      const pxeStoreLogger = createLogger("pxe:data:sqlite-opfs");
      const pxeStore = await AztecSQLiteOPFSStore.open(
        pxeStoreLogger,
        `pxe_data_${rollupAddress}`,
        false,
        `.aztec-kv-pxe-${rollupAddress}`,
      );

      const options: PXECreationOptions = {
        loggers: {
          store: pxeStoreLogger,
          pxe: createLogger("pxe:service"),
          prover: createLogger("bb:native"),
        },
        store: pxeStore,
      };

      const walletDBLogger = createLogger("wallet:data:sqlite-opfs");
      const walletDBStore = await AztecSQLiteOPFSStore.open(
        walletDBLogger,
        `wallet_data_${rollupAddress}`,
        false,
        `.aztec-kv-wallet-${rollupAddress}`,
      );
      const db = WalletDB.init(walletDBStore, walletDBLogger);

      // Interactive-handshake sender relay + per-contact delivery strategy, wired into PXE hooks.
      // Mirrors the Electron wallet-worker; on web the relay is emitted via onWalletEvent (which
      // the browser wallet-api fans out to its listeners) instead of a MessagePort.
      const pendingHandshakeRelays = new Map<
        string,
        PromiseWithResolvers<HandshakeRelayResponse>
      >();
      const interactiveHandshakeTransport = async (request: any) => {
        const id = globalThis.crypto.randomUUID();
        const handle = promiseWithResolvers<HandshakeRelayResponse>();
        pendingHandshakeRelays.set(id, handle);
        onWalletEvent(
          "handshake-relay-request",
          jsonStringify({ id, appId, requestBlob: jsonStringify(request), timestamp: Date.now() }),
        );
        try {
          const response = await handle.promise;
          if (!response.approved || !response.signatureBlob) {
            throw new Error("Interactive handshake relay cancelled by user");
          }
          return RecipientSignatureSchema.parse(JSON.parse(response.signatureBlob));
        } finally {
          pendingHandshakeRelays.delete(id);
        }
      };
      options.hooks = {
        resolveCustomRequest: createInteractiveHandshakeResolver(interactiveHandshakeTransport),
        resolveTaggingSecretStrategy: async ({ recipient }) =>
          (await db.isSenderPrivateChannel(recipient))
            ? ({ type: "interactive-handshake" } as const)
            : ({ type: "non-interactive-handshake" } as const),
      };

      const pxe = await createPXE(node, { ...getPXEConfig(), ...configOverrides }, options);

      const pendingAuthorizations = new Map<
        string,
        {
          promise: PromiseWithResolvers<AuthorizationResponse>;
          request: AuthorizationRequest;
        }
      >();

      if (_cookiePassphrase) {
        // Import capabilities from cookie (full overwrite: cookie is authoritative).
        await bootstrapCapabilitiesFromCookie(db);

        if (!IS_IFRAME) {
          // Accounts and contacts are standalone-only (source of truth).
          await syncAccountsToCookie(db);
          await syncContactsToCookie(db);
        }
        // Export capabilities to cookie (includes both local + newly imported).
        await syncCapabilitiesToCookie(db);
      }

      return { pxe, node, db, pendingAuthorizations, pendingHandshakeRelays };
    })();

    session = { sharedResources: pxeInit, bootstrapDone: null, wallets: new Map() };
    RUNNING_SESSIONS.set(sessionId, session);
  } else {
    createLogger("wallet:session").info(
      `[PXE-INIT] Reusing existing shared PXE instance for sessionId=${sessionId}`,
    );
  }

  const sharedResources = await session.sharedResources;

  if (!session.wallets.has(appId)) {
    const walletInit = async () => {
      const externalLog = createLogger(`wallet:external:${appId}`);
      const internalLog = createLogger(`wallet:internal:${appId}`);

      const externalWallet = new ExternalWallet(
        sharedResources.pxe,
        sharedResources.node,
        sharedResources.db,
        sharedResources.pendingAuthorizations,
        appId,
        chainInfo,
        externalLog,
        sharedResources.pendingHandshakeRelays,
      );

      const internalWallet = new InternalWallet(
        sharedResources.pxe,
        sharedResources.node,
        sharedResources.db,
        sharedResources.pendingAuthorizations,
        appId,
        chainInfo,
        internalLog,
        sharedResources.pendingHandshakeRelays,
      );

      // Register account stub contract classes with PXE so simulations can override
      // real account contracts. Idempotent at the PXE level; each wallet keeps its own
      // stubClassIds map. Required before any buildAccountOverrides call.
      await externalWallet.initStubClasses();
      await internalWallet.initStubClasses();

      const wireEvents = (wallet: ExternalWallet | InternalWallet) => {
        wallet.addEventListener("wallet-update", (event: Event) => {
          const detail = (event as CustomEvent).detail;

          // Sync only the relevant cookie based on the interaction type.
          let type: string | undefined;
          try {
            type = JSON.parse(detail)?.type;
          } catch {
            /* ignore parse errors */
          }

          if (!IS_IFRAME && (type === "createAccount" || type === "deployAccount")) {
            scheduleAccountSync(sharedResources.db);
          } else if (!IS_IFRAME && type === "registerSender") {
            scheduleContactSync(sharedResources.db);
          } else if (type === "requestCapabilities" || type === "capabilityChange") {
            scheduleCapabilitySync(sharedResources.db);
          }

          // Don't forward internal-only events to the UI.
          if (type === "capabilityChange") return;

          onWalletEvent("wallet-update", detail);
        });
        wallet.addEventListener("authorization-request", (event: Event) => {
          onWalletEvent("authorization-request", (event as CustomEvent).detail);
        });
        wallet.addEventListener("proof-debug-export-request", (event: Event) => {
          onWalletEvent("proof-debug-export-request", (event as CustomEvent).detail);
        });
      };

      wireEvents(externalWallet);
      wireEvents(internalWallet);

      // In iframe mode, bootstrap accounts and contacts from cookies into PXE.
      // Runs once per session — first appId triggers it, others await the same promise.
      // Must be serialized to avoid concurrent PXE operations on the same IndexedDB
      // (IDB transactions auto-close on browser, causing "object not usable" errors).
      if (IS_IFRAME && _cookiePassphrase && !session.bootstrapDone) {
        session.bootstrapDone = (async () => {
          await bootstrapAccountsFromCookie(chainInfo, internalWallet);
          await bootstrapContactsFromCookie(sharedResources.db, sharedResources.pxe);
        })();
      }
      if (session.bootstrapDone) {
        await session.bootstrapDone;
      }

      return { external: externalWallet, internal: internalWallet };
    };

    session.wallets.set(appId, walletInit());
  }

  return session.wallets.get(appId)!;
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

    const address = AztecAddress.fromStringUnsafe(portable.address);
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
    await pxe.registerTaggingSecretSource({ kind: "address-derived", sender: address });
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

/** Returns the current sessions map (for debugging / UI inspection) */
export function getRunningSessionIds(): string[] {
  return Array.from(RUNNING_SESSIONS.keys());
}

/**
 * Returns the shared resources for a session (pxe, node, db, pendingAuthorizations).
 * Used by the UI wallet-api to resolve authorization requests directly.
 */
export async function getSharedResources(chainInfo: ChainInfo): Promise<{
  pxe: PXE;
  node: AztecNode;
  db: WalletDB;
  pendingAuthorizations: Map<
    string,
    {
      promise: PromiseWithResolvers<AuthorizationResponse>;
      request: AuthorizationRequest;
    }
  >;
}> {
  const sessionId = `${chainInfo.chainId.toNumber()}-${chainInfo.version.toNumber()}`;
  let session = RUNNING_SESSIONS.get(sessionId);

  // If version is 0 (unresolved), find the session by chainId prefix
  if (!session && chainInfo.version.toNumber() === 0) {
    const prefix = `${chainInfo.chainId.toNumber()}-`;
    for (const [key, value] of RUNNING_SESSIONS) {
      if (key.startsWith(prefix) && key !== sessionId) {
        session = value;
        break;
      }
    }
  }

  if (!session) {
    throw new Error(`No session found for sessionId=${sessionId}`);
  }
  return session.sharedResources;
}
