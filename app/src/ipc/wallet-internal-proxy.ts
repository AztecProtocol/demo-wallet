import {
  promiseWithResolvers,
  type PromiseWithResolvers,
} from "@aztec/foundation/promise";
import { schemaHasMethod } from "@aztec/foundation/schemas";
import type { MessagePortMain } from "electron/main";
import type { AuthorizationRequest } from "../wallet/types/authorization";
import type { WalletInteraction } from "../wallet/types/wallet-interaction";
import {
  type InternalWalletInterface,
  InternalWalletInterfaceSchema,
  type OnAuthorizationRequestListener,
  type OnProofDebugExportRequestListener,
  type OnWalletUpdateListener,
} from "./wallet-internal-interface";

type FunctionsOf<T> = {
  [K in keyof T as T[K] extends Function ? K : never]: T[K];
};

export class WalletInternalProxy {
  private inFlight = new Map<string, PromiseWithResolvers<any>>();
  private internalEventCallback!: OnWalletUpdateListener;
  private authRequestCallback!: OnAuthorizationRequestListener;
  private proofDebugExportCallback!: OnProofDebugExportRequestListener;

  private constructor(private internalPort: MessagePortMain) {}

  public onWalletUpdate(callback: OnWalletUpdateListener) {
    this.internalEventCallback = callback;
  }

  public onAuthorizationRequest(callback: OnAuthorizationRequestListener) {
    this.authRequestCallback = callback;
  }

  public onProofDebugExportRequest(
    callback: OnProofDebugExportRequestListener
  ) {
    this.proofDebugExportCallback = callback;
  }

  static create(internalPort: MessagePortMain) {
    const wallet = new WalletInternalProxy(internalPort);
    internalPort.on("message", async (event) => {
      const { type, content } = event.data;

      // Handle typed events
      if (type === "authorization-request") {
        wallet.authRequestCallback?.(event.data);
        return;
      }

      if (type === "wallet-update") {
        wallet.internalEventCallback?.(event.data);
        return;
      }

      if (type === "proof-debug-export-request") {
        wallet.proofDebugExportCallback?.(event.data.content);
        return;
      }

      const { messageId, result, error } = JSON.parse(content);

      if (!wallet.inFlight.has(messageId)) {
        console.error("No in-flight message for id", messageId);
        return;
      }
      const { resolve, reject } = wallet.inFlight.get(messageId)!;

      if (error) {
        reject(new Error(error));
      } else {
        resolve(result);
      }
      wallet.inFlight.delete(messageId);
    });
    internalPort.start();
    return new Proxy(wallet, {
      get: (target, prop) => {
        if (schemaHasMethod(InternalWalletInterfaceSchema, prop.toString())) {
          return async (...args: any[]) => {
            return target.postMessage({
              type: prop.toString() as keyof FunctionsOf<InternalWalletInterface>,
              args,
            });
          };
        } else {
          return target[prop];
        }
      },
    }) as unknown as InternalWalletInterface;
  }

  private async postMessage({
    type,
    args,
  }: {
    type: keyof FunctionsOf<InternalWalletInterface>;
    args: any[];
  }) {
    const messageId = globalThis.crypto.randomUUID();
    const appId = "this";
    const [chainId, version, ...originaArgs] = args;
    const message = {
      type,
      args: originaArgs,
      messageId,
      appId,
      chainInfo: { chainId, version },
    };
    this.internalPort.postMessage(message);
    const { promise, resolve, reject } = promiseWithResolvers<any>();
    this.inFlight.set(messageId, { promise, resolve, reject });
    return promise;
  }
}
