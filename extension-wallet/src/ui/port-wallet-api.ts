import type { Fr } from "@aztec/aztec.js/fields";
import type { InternalWalletInterface } from "@demo-wallet/shared/core";
import type { PortClient } from "../ipc/port-client";
import { parseEventDetail } from "../ipc/parse-event-detail";

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
        // Wallet event payloads (wallet-update / authorization-request /
        // proof-debug-export-request) are JSON-stringified at the source —
        // see `WalletUpdateEvent` in shared/wallet/types/wallet-interaction.ts.
        // The web flavor's `wallet-api.ts` parses them on receive; our port
        // proxy needs to do the same so consumers get an object, not a string.
        return (cb: (p: unknown) => void) =>
          client.onBroadcast(event, (raw) => cb(parseEventDetail(raw)));
      }
      return (...args: unknown[]) => client.call(`wallet.${prop}`, args);
    },
  }) as InternalWalletInterface;
}
