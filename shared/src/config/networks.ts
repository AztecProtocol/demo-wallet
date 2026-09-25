import { Fr } from "@aztec-labs/aztec.js/fields";

export interface NetworkConfig {
  id: string;
  name: string;
  chainId: number;
  version: number;
  description: string;
  color: string;
  nodeUrl?: string;
  /** Sent as the `x-aztec-api-key` header on every node request, for nodes behind an API gateway. */
  apiKey?: string;
}

export const NETWORKS: NetworkConfig[] = [
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
    // Stand-in for testnet on the v6 line until an official v6 testnet exists. Sepolia L1.
    id: "staging-public",
    name: "Staging Public",
    chainId: 11155111,
    version: 0, // Auto-detect rollup version from the node
    description: "Aztec Labs public staging network",
    color: "#f38721",
    nodeUrl: "https://staging-public.rpc.aztec-labs.com",
    // Injected at build time; the node's gateway rejects requests without it
    apiKey: import.meta.env.VITE_STAGING_PUBLIC_API_KEY,
  },
];

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
