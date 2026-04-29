import type { ChainInfo } from "@aztec/aztec.js/account";
import { Fr } from "@aztec/aztec.js/fields";
import { WalletSchema } from "@aztec/aztec.js/wallet";
import { getOrCreateSession, InternalWalletInterfaceSchema } from "@demo-wallet/shared/core";
import { VaultState } from "../vault/vault-state";
import { PortServer, type MethodHandlerMap } from "../ipc/port-server";

export class WalletHost {
  private vault = new VaultState();
  private server: PortServer;
  /** Currently selected network (set by UI; defaults to localhost). */
  private currentChainInfo: ChainInfo = { chainId: new Fr(31337), version: new Fr(0) };

  constructor() {
    this.server = new PortServer(this.buildHandlers());
  }

  start() {
    this.server.start();
    this.vault.onChange((state) => {
      if (state === "locked") {
        this.server.broadcast("vault-locked", null);
      } else {
        this.server.broadcast("vault-unlocked", null);
      }
    });
  }

  private buildHandlers(): MethodHandlerMap {
    return {
      "vault.isInitialized": async () => await this.vault.isInitialized(),
      "vault.isUnlocked": async () => this.vault.isUnlocked(),
      "vault.initialize": async (password) =>
        await this.vault.initialize(password as string),
      "vault.unlock": async (password) => await this.vault.unlock(password as string),
      "vault.lock": async () => this.vault.lock(),

      "network.set": async (chainId, version) => {
        this.currentChainInfo = {
          chainId: Fr.fromString(chainId as string),
          version: Fr.fromString(version as string),
        };
      },
      "network.get": async () => ({
        chainId: this.currentChainInfo.chainId.toString(),
        version: this.currentChainInfo.version.toString(),
      }),

      ...this.buildWalletMethodHandlers(),
      ...this.buildDappMethodHandlers(),
    };
  }

  private forwardWalletEvent = (eventType: string, detail: unknown) => {
    if (eventType === "wallet-update") {
      this.server.broadcast("wallet-update", detail);
    } else if (eventType === "authorization-request") {
      this.server.broadcast("authorization-request", detail);
    } else if (eventType === "proof-debug-export-request") {
      this.server.broadcast("proof-debug-export-request", detail);
    }
  };

  private buildWalletMethodHandlers(): MethodHandlerMap {
    const guard = async () => {
      if (!this.vault.isUnlocked()) {
        throw new Error("Vault is locked");
      }
      const { internal } = await getOrCreateSession(
        this.currentChainInfo,
        "ui",
        this.forwardWalletEvent,
      );
      return internal;
    };

    const handlers: MethodHandlerMap = {};
    for (const methodName of Object.keys(InternalWalletInterfaceSchema)) {
      handlers[`wallet.${methodName}`] = async (...args: unknown[]) => {
        const wallet = await guard();
        const fn = (wallet as unknown as Record<string, (...a: unknown[]) => unknown>)[
          methodName
        ];
        if (typeof fn !== "function") {
          throw new Error(`Method ${methodName} not found on InternalWallet`);
        }
        return await fn.apply(wallet, args);
      };
    }
    return handlers;
  }

  /**
   * Build handlers for `dapp.*` methods. Each forwards to the per-session
   * ExternalWallet identified by `session.appId` + `session.chainInfo`.
   * Called shape: handler(session, message), where message.args is the call payload.
   */
  private buildDappMethodHandlers(): MethodHandlerMap {
    const handlers: MethodHandlerMap = {};
    for (const methodName of Object.keys(WalletSchema)) {
      handlers[`dapp.${methodName}`] = async (...callArgs: unknown[]) => {
        if (!this.vault.isUnlocked()) {
          throw new Error("Vault is locked");
        }
        const [session, message] = callArgs;
        const sess = session as { appId: string; chainInfo: ChainInfo };
        const msg = message as { args?: unknown[] };

        const { external } = await getOrCreateSession(
          sess.chainInfo,
          sess.appId,
          this.forwardWalletEvent,
        );
        const args = msg.args ?? [];
        const fn = (external as unknown as Record<string, (...a: unknown[]) => unknown>)[
          methodName
        ];
        if (typeof fn !== "function") {
          throw new Error(`Method ${methodName} not found on ExternalWallet`);
        }
        return await fn.apply(external, args);
      };
    }
    return handlers;
  }
}
