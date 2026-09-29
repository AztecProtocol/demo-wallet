import { createAztecNodeClient, type AztecNode } from "@aztec-labs/aztec.js/node";
import { defaultFetch } from "@aztec-labs/foundation/json-rpc/client";
import type { NetworkConfig } from "./networks.ts";

/**
 * Header the node gateway reads the API key from. The rpc2 nodes (testnet) sit behind AWS API
 * Gateway, whose key header is `x-api-key`; a missing or wrong key comes back
 * `403 {"message":"Forbidden"}`, indistinguishable from each other.
 */
export const AZTEC_API_KEY_HEADER = "x-api-key";

/** Creates a node RPC client for the network, authenticating with its API key if it has one. */
export function createNodeClient(network: NetworkConfig): AztecNode {
  if (!network.nodeUrl) {
    throw new Error(`Network ${network.id} has no node URL`);
  }
  const { apiKey } = network;
  const fetch: typeof defaultFetch | undefined = apiKey
    ? (host, body, extraHeaders = {}, noRetry = false) =>
        defaultFetch(host, body, { ...extraHeaders, [AZTEC_API_KEY_HEADER]: apiKey }, noRetry)
    : undefined;
  return createAztecNodeClient(network.nodeUrl, { fetch });
}
