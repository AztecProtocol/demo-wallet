/**
 * Host-agnostic browser-wallet session manager.
 *
 * Manages PXE sessions indexed by `chainId-version`. Each session has one
 * shared PXE instance (critical: multiple PXE instances sharing the same
 * IndexedDB store cause Map/storage desync) plus per-appId wallet pairs.
 *
 * This module is the host-agnostic core that the web wallet and the
 * browser-extension wallet both build on. It does not know about cookies,
 * iframes, or any host-specific persistence; callers wire those concerns
 * via the `onWalletEvent` callback.
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
import { createLogger } from "@aztec/aztec.js/log";
import { type PromiseWithResolvers } from "@aztec/foundation/promise";
import {
  ExternalWallet,
  InternalWallet,
  WalletDB,
  type AuthorizationRequest,
  type AuthorizationResponse,
} from "../index.ts";
import { getNetworkByChainId } from "../../config/networks.ts";
import {
  createPXE,
  getPXEConfig,
  type PXE,
  type PXEConfig,
  type PXECreationOptions,
} from "@aztec/pxe/client/lazy";
import { createStore } from "@aztec/kv-store/indexeddb";

export type SharedResources = {
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
};

export type SessionData = {
  sharedResources: Promise<SharedResources>;
  wallets: Map<string, Promise<{ external: ExternalWallet; internal: InternalWallet }>>;
};

/**
 * Test seam: factory that produces the shared resources for a session.
 *
 * Production code uses `defaultSharedResourcesFactory`, which spins up a real
 * PXE / IndexedDB store / WalletDB. Tests can override this via
 * `__setSharedResourcesFactoryForTests` to exercise the session-keying logic
 * without requiring a live Aztec node.
 */
export type SharedResourcesFactory = (node: AztecNode) => Promise<SharedResources>;

const sessionLog = createLogger("wallet:session");

const defaultSharedResourcesFactory: SharedResourcesFactory = async (node) => {
  const l1Contracts = await node.getL1ContractAddresses();
  const rollupAddress = l1Contracts.rollupAddress;

  const configOverrides: Partial<PXEConfig> = {
    dataDirectory: `./pxe-${rollupAddress}`,
    proverEnabled: true,
  };

  const options: PXECreationOptions = {
    loggers: {
      store: createLogger("pxe:data:lmdb"),
      pxe: createLogger("pxe:service"),
      prover: createLogger("bb:native"),
    },
    store: await createStore(
      `pxe-${rollupAddress}`,
      {
        dataDirectory: configOverrides.dataDirectory,
        dataStoreMapSizeKb: 2e10,
      },
      2,
      createLogger("pxe:data:lmdb"),
    ),
  };

  const walletDBLogger = createLogger("wallet:data:lmdb");
  const walletDBStore = await createStore(
    `wallet-${rollupAddress}`,
    {
      dataDirectory: `wallet-${rollupAddress}`,
      dataStoreMapSizeKb: 2e10,
    },
    2,
    walletDBLogger,
  );
  const db = WalletDB.init(walletDBStore, walletDBLogger);

  const pxe = await createPXE(node, { ...getPXEConfig(), ...configOverrides }, options);

  const pendingAuthorizations = new Map<
    string,
    {
      promise: PromiseWithResolvers<AuthorizationResponse>;
      request: AuthorizationRequest;
    }
  >();

  return { pxe, node, db, pendingAuthorizations };
};

let sharedResourcesFactory: SharedResourcesFactory = defaultSharedResourcesFactory;

/**
 * Test seam for the node-client builder. Production code uses
 * `createAztecNodeClient` from @aztec/aztec.js/node, but tests can swap in
 * a fake node via `__setNodeClientFactoryForTests` to skip auto-version
 * detection (which performs a real network call).
 */
export type NodeClientFactory = (nodeUrl: string) => AztecNode;
let nodeClientFactory: NodeClientFactory = createAztecNodeClient;

const RUNNING_SESSIONS = new Map<string, SessionData>();

/**
 * Get-or-create the session for `chainInfo` and the wallet pair for `appId`.
 *
 * Returns the resolved canonical `sessionId` (`${chainId}-${version}`)
 * alongside the wallet pair. Callers should prefer this `sessionId` over
 * recomputing one from the input `chainInfo` because version auto-detection
 * (when `chainInfo.version === 0`) happens inside this function — the
 * input `chainInfo`'s version may differ from the resolved one.
 */
export async function getOrCreateSession(
  chainInfo: ChainInfo,
  appId: string,
  onWalletEvent: (eventType: string, detail: unknown) => void,
): Promise<{ external: ExternalWallet; internal: InternalWallet; sessionId: string }> {
  const network = getNetworkByChainId(chainInfo.chainId.toNumber(), chainInfo.version.toNumber());
  if (!network) {
    throw new Error(
      `Unknown network: chainId=${chainInfo.chainId.toNumber()}, version=${chainInfo.version.toNumber()}`,
    );
  }

  const node = nodeClientFactory(network.nodeUrl!);

  // Auto-detect version if 0. `rollupVersion` shape has shifted across Aztec
  // SDK versions — sometimes Fr, sometimes bigint/number, sometimes a hex
  // string. Narrow defensively at runtime so we accept any of those, since
  // the SDK's compile-time type doesn't always match the runtime value.
  if (chainInfo.version.equals(new Fr(0))) {
    const { rollupVersion } = await node.getNodeInfo();
    const raw: unknown = rollupVersion;
    const versionFr =
      raw instanceof Fr
        ? raw
        : typeof raw === "string"
          ? Fr.fromString(raw)
          : new Fr(raw as bigint | number | boolean);
    chainInfo = { ...chainInfo, version: versionFr };
  }

  const sessionId = `${chainInfo.chainId.toNumber()}-${chainInfo.version.toNumber()}`;
  let session = RUNNING_SESSIONS.get(sessionId);

  if (!session) {
    sessionLog.info(
      `[PXE-INIT] Creating NEW session with shared PXE instance for sessionId=${sessionId}`,
    );

    const sharedResources = sharedResourcesFactory(node);
    session = { sharedResources, wallets: new Map() };
    RUNNING_SESSIONS.set(sessionId, session);
  } else {
    sessionLog.info(
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
      );

      const internalWallet = new InternalWallet(
        sharedResources.pxe,
        sharedResources.node,
        sharedResources.db,
        sharedResources.pendingAuthorizations,
        appId,
        chainInfo,
        internalLog,
      );

      const wireEvents = (wallet: ExternalWallet | InternalWallet) => {
        wallet.addEventListener("wallet-update", (event: Event) => {
          const detail = (event as CustomEvent).detail;
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

      return { external: externalWallet, internal: internalWallet };
    };

    session.wallets.set(appId, walletInit());
  }

  const wallet = await session.wallets.get(appId)!;
  return { ...wallet, sessionId };
}

/** Returns the current sessions map (for debugging / UI inspection) */
export function getRunningSessionIds(): string[] {
  return Array.from(RUNNING_SESSIONS.keys());
}

/**
 * Returns the shared resources for a session (pxe, node, db, pendingAuthorizations).
 * Used by the UI wallet-api to resolve authorization requests directly.
 *
 * Pass the canonical `sessionId` returned from `getOrCreateSession`. Computing
 * a sessionId from a `chainInfo` whose `version` is still `0` will not find
 * the session — that's by design; callers must flow the resolved sessionId.
 */
export async function getSharedResources(sessionId: string): Promise<SharedResources> {
  const session = RUNNING_SESSIONS.get(sessionId);
  if (!session) {
    throw new Error(`No session found for sessionId=${sessionId}`);
  }
  return session.sharedResources;
}

/**
 * Test-only helper. Not exported from the package barrel; import directly
 * from `./session` in tests.
 */
export function __resetSessionsForTests() {
  RUNNING_SESSIONS.clear();
  sharedResourcesFactory = defaultSharedResourcesFactory;
  nodeClientFactory = createAztecNodeClient;
}

/** Test-only: override the shared-resources factory (e.g. to bypass real PXE init). */
export function __setSharedResourcesFactoryForTests(factory: SharedResourcesFactory) {
  sharedResourcesFactory = factory;
}

/** Test-only: override the node-client factory (e.g. to bypass real network calls). */
export function __setNodeClientFactoryForTests(factory: NodeClientFactory) {
  nodeClientFactory = factory;
}
