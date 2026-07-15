/**
 * Browser wallet API — replaces the Electron IPC-based WalletApi.
 *
 * In the Electron app, wallet-api.ts proxied method calls through window.walletAPI
 * (preload bridge) → IPC → wallet-worker.ts. Here we call InternalWallet directly
 * since the wallet runs in the same browser context.
 */

import { type Fr } from "@aztec/foundation/schemas";
import type { InternalWalletInterface, AuthorizationResponse } from "@demo-wallet/shared/core";
import { getOrCreateSession } from "../../wallet/wallet-service.ts";

// Event emitter for wallet update and authorization request events.
// These are global because they are session-level (not per-API instance).
type WalletUpdateListener = (event: any) => void;
type AuthorizationRequestListener = (event: any) => void;
type ProofDebugExportListener = (event: any) => void;
type HandshakeRelayRequestListener = (event: any) => void;

const walletUpdateListeners = new Set<WalletUpdateListener>();
const authorizationRequestListeners = new Set<AuthorizationRequestListener>();
const proofDebugExportListeners = new Set<ProofDebugExportListener>();
const handshakeRelayRequestListeners = new Set<HandshakeRelayRequestListener>();

export function emitWalletUpdate(detail: unknown) {
  const parsed = typeof detail === "string" ? JSON.parse(detail) : detail;
  walletUpdateListeners.forEach((cb) => cb(parsed));
}

function emitAuthorizationRequest(detail: unknown) {
  // detail arrives as a JSON string (from AuthorizationRequestEvent which calls jsonStringify)
  const parsed = typeof detail === "string" ? JSON.parse(detail) : detail;
  authorizationRequestListeners.forEach((cb) => cb(parsed));
}

function emitProofDebugExportRequest(detail: unknown) {
  const parsed = typeof detail === "string" ? JSON.parse(detail) : detail;
  proofDebugExportListeners.forEach((cb) => cb(parsed));
}

function emitHandshakeRelayRequest(detail: unknown) {
  const parsed = typeof detail === "string" ? JSON.parse(detail) : detail;
  handshakeRelayRequestListeners.forEach((cb) => cb(parsed));
}

// Cache: chainId-version → InternalWallet
const walletCache = new Map<
  string,
  Promise<Awaited<ReturnType<typeof getOrCreateSession>>["internal"]>
>();

function getCacheKey(chainId: Fr, version: Fr): string {
  return `${chainId.toString()}-${version.toString()}`;
}

async function getInternalWallet(
  chainId: Fr,
  version: Fr,
): Promise<Awaited<ReturnType<typeof getOrCreateSession>>["internal"]> {
  const key = getCacheKey(chainId, version);
  if (!walletCache.has(key)) {
    const p = getOrCreateSession({ chainId, version }, "internal-ui", (eventType, detail) => {
      if (eventType === "wallet-update") emitWalletUpdate(detail);
      else if (eventType === "authorization-request") emitAuthorizationRequest(detail);
      else if (eventType === "proof-debug-export-request") emitProofDebugExportRequest(detail);
      else if (eventType === "handshake-relay-request") emitHandshakeRelayRequest(detail);
    }).then(({ internal }) => internal);
    walletCache.set(key, p);
  }
  return walletCache.get(key)!;
}

export class WalletApi {
  private constructor(
    private chainId: Fr,
    private version: Fr,
  ) {
    return new Proxy(this, {
      get: (target, prop) => {
        const propStr = prop.toString();

        // Event subscriptions
        if (propStr === "onWalletUpdate") {
          return (callback: WalletUpdateListener) => {
            walletUpdateListeners.add(callback);
            return () => walletUpdateListeners.delete(callback);
          };
        }
        if (propStr === "onAuthorizationRequest") {
          return (callback: AuthorizationRequestListener) => {
            authorizationRequestListeners.add(callback);
            return () => authorizationRequestListeners.delete(callback);
          };
        }
        if (propStr === "onProofDebugExportRequest") {
          return (callback: ProofDebugExportListener) => {
            proofDebugExportListeners.add(callback);
            return () => proofDebugExportListeners.delete(callback);
          };
        }
        if (propStr === "onHandshakeRelayRequest") {
          return (callback: HandshakeRelayRequestListener) => {
            handshakeRelayRequestListeners.add(callback);
            return () => handshakeRelayRequestListeners.delete(callback);
          };
        }
        if (propStr === "saveProofDebugData") {
          // No-op in web wallet (no native file system dialog)
          return () => Promise.resolve();
        }

        // resolveAuthorization is handled specially — not on InternalWallet directly
        if (propStr === "resolveAuthorization") {
          return async (response: AuthorizationResponse) => {
            // InternalWallet doesn't expose resolveAuthorization directly;
            // it lives in the shared pendingAuthorizations map accessed via the session.
            await resolveAuthorizationViaSession(target.chainId, target.version, response);
          };
        }

        // Block account creation in iframe mode to prevent desyncs with cookie
        if (propStr === "createAccount" && window.self !== window.top) {
          return async () => {
            throw new Error(
              "Account creation is not available in embedded mode. " +
                "Please create accounts in the standalone wallet.",
            );
          };
        }

        // All other methods: delegate to InternalWallet
        return async (...args: any[]) => {
          const wallet = await getInternalWallet(target.chainId, target.version);
          const method = (wallet as any)[propStr];
          if (typeof method !== "function") {
            throw new Error(`InternalWallet has no method: ${propStr}`);
          }
          return method.apply(wallet, args);
        };
      },
    }) as unknown as WalletApi;
  }

  static create(chainId: Fr, version: Fr): InternalWalletInterface {
    return new WalletApi(chainId, version) as unknown as InternalWalletInterface;
  }
}

// resolveAuthorization needs to reach the shared pendingAuthorizations map.
// We access it by going through wallet-service's session.
import { getSharedResources } from "../../wallet/wallet-service.ts";

async function resolveAuthorizationViaSession(
  chainId: Fr,
  version: Fr,
  response: AuthorizationResponse,
): Promise<void> {
  const resources = await getSharedResources({ chainId, version });
  const pending = resources.pendingAuthorizations.get(response.id);
  if (pending) {
    pending.promise.resolve(response);
    resources.pendingAuthorizations.delete(response.id);
  }
}
