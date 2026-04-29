import type { Fr } from "@aztec/aztec.js/fields";
import type { InternalWalletInterface } from "@demo-wallet/shared/core";
import type { PortClient } from "../ipc/port-client";

const EVENT_BY_METHOD: Record<
  string,
  "wallet-update" | "authorization-request" | "proof-debug-export-request"
> = {
  onWalletUpdate: "wallet-update",
  onAuthorizationRequest: "authorization-request",
  onProofDebugExportRequest: "proof-debug-export-request",
};

/**
 * Port-backed implementation of InternalWalletInterface.
 *
 * Method calls become `wallet.<name>` requests over the port; event-listener
 * registrations (`onWalletUpdate`, etc.) become broadcast subscriptions.
 *
 * Tells the offscreen which network this UI is bound to via `network.set`.
 */
export function makePortWalletApi(
  client: PortClient,
  chainId: Fr,
  version: Fr,
): InternalWalletInterface {
  void client.call("network.set", [chainId.toString(), version.toString()]);

  return new Proxy({} as InternalWalletInterface, {
    get(_t, prop) {
      if (typeof prop !== "string" || prop === "then") return undefined;
      const event = EVENT_BY_METHOD[prop];
      if (event) {
        return (cb: (p: unknown) => void) => client.onBroadcast(event, cb);
      }
      return (...args: unknown[]) => client.call(`wallet.${prop}`, args);
    },
  }) as InternalWalletInterface;
}
