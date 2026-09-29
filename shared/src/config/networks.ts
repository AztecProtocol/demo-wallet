import { Fr } from "@aztec-labs/aztec.js/fields";

export interface NetworkConfig {
  id: string;
  name: string;
  chainId: number;
  version: number;
  description: string;
  color: string;
  nodeUrl?: string;
  /**
   * Sent as the `x-api-key` header on every node request, for nodes behind an API gateway.
   * Filled in from the `VITE_<ID>_API_KEY` build-time env var (see {@link apiKeyEnvVar}).
   */
  apiKey?: string;
}

/**
 * Name of the build-time env var holding a network's API key: `VITE_` + the network id in
 * upper snake case + `_API_KEY` (e.g. `testnet` → `VITE_TESTNET_API_KEY`). CI fills it from the
 * repo secret of the same name minus the `VITE_` prefix (`TESTNET_API_KEY`).
 */
export function apiKeyEnvVar(networkId: string): `VITE_${string}_API_KEY` {
  return `VITE_${networkId.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
}

function withApiKey(network: NetworkConfig): NetworkConfig {
  const apiKey = import.meta.env[apiKeyEnvVar(network.id)];
  return apiKey ? { ...network, apiKey } : network;
}

export const NETWORKS: NetworkConfig[] = (
  [
    {
      id: "localhost",
      name: "Localhost",
      chainId: 31337,
      version: 0, // Auto-detect version
      description: "Local development network",
      color: "#4caf50",
      nodeUrl: "http://localhost:8080",
    },
    {
      id: "testnet",
      name: "Testnet",
      chainId: 11155111,
      version: 0, // Auto-detect rollup version from the node
      description: "Aztec Labs Testnet",
      color: "#f38721",
      nodeUrl: "https://testnet-v6.rpc2.aztec-labs.com",
    },
  ] satisfies NetworkConfig[]
).map(withApiKey);

export const DEFAULT_NETWORK = NETWORKS[1];

export function getNetworkById(id: string): NetworkConfig | undefined {
  return NETWORKS.find((network) => network.id === id);
}

export function getNetworkByChainId(chainId: number, version?: number): NetworkConfig | undefined {
  return NETWORKS.find((network) => {
    if (network.version !== 0) {
      return network.chainId === chainId && network.version === version;
    }
    return network.chainId === chainId;
  });
}

export function networkToChainInfo(network: NetworkConfig): {
  chainId: Fr;
  version: Fr;
} {
  return {
    chainId: new Fr(network.chainId),
    version: new Fr(network.version),
  };
}
