import { createAztecNodeClient, type AztecNode } from "@aztec-labs/aztec.js/node";
import { defaultFetch } from "@aztec-labs/foundation/json-rpc/client";
import type { NetworkConfig } from "./networks.ts";

/**
 * Header the node gateway reads the API key from. staging-public is fronted by Kong, which
 * rejects any other header name with `401 {"message":"No API key found in request"}`, and its
 * CORS preflight allows only this one.
 */
export const AZTEC_API_KEY_HEADER = "x-aztec-api-key";

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
