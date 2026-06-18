import { createAztecNodeClient } from "@aztec/aztec.js/node";
import { type ChainInfo } from "@aztec/aztec.js/account";
import { WalletSchema } from "@aztec/aztec.js/wallet";
import { Fr } from "@aztec/aztec.js/fields";
import { getSchemaParameters, parseWithOptionals, schemaHasMethod } from "@aztec/foundation/schemas";
import { jsonStringify } from "@aztec/foundation/json-rpc";
import type { MessagePortMain } from "electron";
import {
  ExternalWallet,
  InternalWallet,
  WalletDB,
  InternalWalletInterfaceSchema,
  getNetworkByChainId,
} from "@demo-wallet/shared/core";
import { createProxyLogger } from "../utils/logger.ts";
import type { Logger } from "@aztec/foundation/log";
import type { AuthorizationRequest, AuthorizationResponse } from "@demo-wallet/shared/core";
import {
  createPXE,
  getPXEConfig,
  type PXEConfig,
  type PXECreationOptions,
} from "@aztec/pxe/server";
import { schemas } from "@aztec/stdlib/schemas";

import { createStore } from "@aztec/kv-store/lmdb-v2";
import { resolve, join } from "node:path";
import { z } from "zod";
import { homedir } from "node:os";
import { inspect } from "node:util";
import type { PromiseWithResolvers } from "@aztec/foundation/promise";
import { BackendType } from "@aztec/bb.js";

const ChainInfoSchema = z.object({
  chainId: schemas.Fr,
  version: schemas.Fr,
});

// Session data indexed by sessionId (chainId-version)
// Each session contains shared PXE resources and a map of wallets per appId
type SessionData = {
  sharedResources: Promise<{
    pxe: any;
    node: any;
    db: any;
    pendingAuthorizations: Map<string, any>;
  }>;
  wallets: Map<string, Promise<{ external: ExternalWallet; internal: InternalWallet }>>;
};

const RUNNING_SESSIONS = new Map<string, SessionData>();

async function init(
  chainInfo: ChainInfo,
  appId: string,
  internalPort: MessagePortMain,
  logPort: MessagePortMain,
) {
  const network = getNetworkByChainId(chainInfo.chainId.toNumber(), chainInfo.version.toNumber());
  if (!network) {
    throw new Error(
      `Unknown network: chainId=${chainInfo.chainId.toNumber()}, version=${chainInfo.version.toNumber()}`,
    );
  }
  const node = createAztecNodeClient(network.nodeUrl!);
  if (chainInfo.version.equals(new Fr(0))) {
    const { rollupVersion } = await node.getNodeInfo();
    chainInfo.version = new Fr(rollupVersion);
  }
  const sessionId = `${chainInfo.chainId.toNumber()}-${chainInfo.version.toNumber()}`;

  let session = RUNNING_SESSIONS.get(sessionId);
  const walletExists = session?.wallets.has(appId);

  // First, ensure we have a session with shared PXE resources
  if (!session) {
    const pxeInit = (async () => {
      const l1Contracts = await node.getL1ContractAddresses();
      const rollupAddress = l1Contracts.rollupAddress;
      const keychainHomeDir = join(homedir(), "keychain");

      const configOverrides: Partial<PXEConfig> = {
        dataDirectory: resolve(keychainHomeDir, `./pxe-${rollupAddress}`),
        proverEnabled: true,
      };

      const options: PXECreationOptions = {
        loggers: {
          store: createProxyLogger("pxe:data:lmdb", logPort),
          pxe: createProxyLogger("pxe:service", logPort),
          prover: createProxyLogger("bb:native", logPort),
        },
        store: await createStore(
          `pxe-${rollupAddress}`,
          2,
          {
            dataDirectory: configOverrides.dataDirectory,
            dataStoreMapSizeKb: 2e10,
          },
          createProxyLogger("pxe:data:lmdb", logPort).getBindings(),
        ),
        proverOrOptions: {
          backend: BackendType.NativeUnixSocket,
          bbPath: process.env.BB_BINARY_PATH,
        },
      };

      const walletDBLogger = createProxyLogger("wallet:data:lmdb", logPort);
      const walletDBStore = await createStore(
        `wallet-${rollupAddress}`,
        2,
        {
          dataDirectory: resolve(keychainHomeDir, `wallet-${rollupAddress}`),
          dataStoreMapSizeKb: 2e10,
        },
        walletDBLogger.getBindings(),
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
    })();

    session = {
      sharedResources: pxeInit,
      wallets: new Map(),
    };
    RUNNING_SESSIONS.set(sessionId, session);
  }

  // Wait for the shared PXE to be ready
  const sharedResources = await session.sharedResources;

  // Now create wallet instances for this specific appId if they don't exist
  if (!walletExists) {
    const internalInit = async () => {
      const externalWalletLogger = createProxyLogger(`wallet:external:${appId}`, logPort);
      const internalWalletLogger = createProxyLogger(`wallet:internal:${appId}`, logPort);

      // Create both wallet instances sharing the same db, pxe and authorization logic
      const externalWallet = new ExternalWallet(
        sharedResources.pxe,
        sharedResources.node,
        sharedResources.db,
        sharedResources.pendingAuthorizations,
        appId,
        chainInfo,
        externalWalletLogger,
      );
      const internalWallet = new InternalWallet(
        sharedResources.pxe,
        sharedResources.node,
        sharedResources.db,
        sharedResources.pendingAuthorizations,
        appId,
        chainInfo,
        internalWalletLogger,
      );

      // Register account stub contract classes with PXE so simulations can override
      // real account contracts. Idempotent at the PXE level; each wallet keeps its own
      // stubClassIds map. Required before any buildAccountOverrides call.
      await externalWallet.initStubClasses();
      await internalWallet.initStubClasses();

      // Wire up events from both wallets to internal port
      const setupWalletEvents = (wallet: ExternalWallet | InternalWallet) => {
        wallet.addEventListener("wallet-update", (event: Event) => {
          internalPort.postMessage({
            origin: "wallet",
            type: "wallet-update",
            content: (event as CustomEvent).detail,
            chainInfo: {
              chainId: chainInfo.chainId.toString(),
              version: chainInfo.version.toString(),
            },
          });
        });

        wallet.addEventListener("authorization-request", (event: Event) => {
          internalPort.postMessage({
            origin: "wallet",
            type: "authorization-request",
            content: (event as CustomEvent).detail,
            chainInfo: {
              chainId: chainInfo.chainId.toString(),
              version: chainInfo.version.toString(),
            },
          });
        });

        wallet.addEventListener("proof-debug-export-request", (event: Event) => {
          internalPort.postMessage({
            origin: "wallet",
            type: "proof-debug-export-request",
            content: (event as CustomEvent).detail,
            chainInfo: {
              chainId: chainInfo.chainId.toString(),
              version: chainInfo.version.toString(),
            },
          });
        });
      };

      setupWalletEvents(externalWallet);
      setupWalletEvents(internalWallet);

      return { external: externalWallet, internal: internalWallet };
    };

    const walletPromise = internalInit();
    session.wallets.set(appId, walletPromise);
  }

  const wallets = await session.wallets.get(appId)!;
  return wallets;
}

const handleEvent = async (
  port: MessagePortMain,
  wallet: ExternalWallet | InternalWallet,
  schema: typeof WalletSchema | typeof InternalWalletInterfaceSchema,
  type: string,
  messageId: string,
  args: any[],
  userLog: Logger,
) => {
  if (!schemaHasMethod(schema, type)) {
    throw new Error(`Unknown method: ${type}`);
  }
  const sanitizedArgs = await parseWithOptionals(
    args,
    getSchemaParameters(schema[type]) as Parameters<typeof parseWithOptionals>[1],
  );
  let result;
  let error;
  try {
    const method = (wallet as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>)[
      type
    ].bind(wallet);
    result = await method(...sanitizedArgs);
  } catch (err: any) {
    userLog.error(`Error handling ${type}: ${err.message}`);
    if (err.stack) {
      userLog.error(`Stack trace: ${err.stack}`);
    }
    // Serialize error properly - Error objects don't stringify well
    error = err instanceof Error ? err.message : String(err);
  }
  port.postMessage({
    origin: "wallet",
    content: jsonStringify({ messageId, result, error }),
  });
};

async function main() {
  let userLog: Logger | undefined;
  process.on("unhandledRejection", (error: Error) => {
    console.error("Unhandled rejection in worker:", error);
    if (userLog) {
      userLog.error(
        `Unhandled rejection ${typeof error.message == "object" ? inspect(error.message) : error.message}`,
      );
    }
  });

  process.on("uncaughtException", (error: Error) => {
    console.error("Uncaught exception in worker:", error);
    if (userLog) {
      userLog.error(
        `Unhandled rejection ${typeof error.message == "object" ? inspect(error.message) : error.message}`,
      );
    }
  });

  process.parentPort.once("message", async (message: any) => {
    if (message.data.type === "ports" && message.ports?.length) {
      const [externalPort, internalPort, logPort] = message.ports;
      const log = createProxyLogger("wallet:worker", logPort);
      userLog = log;

      externalPort.on("message", async (event: Electron.MessageEvent) => {
        const { origin, content } = event.data;
        if (origin !== "native-host") {
          return;
        }
        let messageContent;
        try {
          messageContent = JSON.parse(content);
        } catch {
          log.debug(`Unable to parse message ${content}`);
          return;
        }
        const { type, messageId, args, appId, chainInfo } = messageContent;
        if (appId === "this") {
          throw new Error("External messages cannot have this as appId");
        }
        log.debug("Received external message:", event.data);
        const parsedChainInfo = ChainInfoSchema.parse(chainInfo);
        const wallets = await init(
          parsedChainInfo as unknown as ChainInfo,
          appId,
          internalPort,
          logPort,
        );
        // Use external wallet for external requests
        handleEvent(externalPort, wallets.external, WalletSchema, type, messageId, args, log);
      });
      internalPort.on("message", async (event: Electron.MessageEvent) => {
        const { type, messageId, args, appId: originalAppId, chainInfo } = event.data;
        if (!messageId) {
          return;
        }
        const parsedChainInfo = ChainInfoSchema.parse(chainInfo);
        log.debug("Received internal message:", {
          type,
          messageId,
          args,
          chainInfo: parsedChainInfo,
          originalAppId,
        });

        // If this is an authorization response, it originated from an app, but
        // was handled interally. Recover the original app from the args.
        const appId =
          // This is sligthly ugly since we're taking advantage of the fact that
          // we know the shape of the args for this specific method.
          type === "resolveAuthorization" && args[0].appId !== "this"
            ? args[0].appId
            : originalAppId;

        const wallets = await init(
          parsedChainInfo as unknown as ChainInfo,
          appId,
          internalPort,
          logPort,
        );
        // Use internal wallet for internal requests, except when handling
        // resolveAuthorization (which was always originated by the external one)
        const wallet =
          type === "resolveAuthorization" && appId !== "this" ? wallets.external : wallets.internal;
        handleEvent(
          internalPort,
          wallet,
          InternalWalletInterfaceSchema,
          type,
          messageId,
          args,
          log,
        );
      });
      externalPort.start();
      internalPort.start();
      logPort.start();
    }
  });

  console.log("Worker setup complete, waiting for messages...");
}

console.log("About to call main()...");
main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
