import { Fr } from "@aztec/aztec.js/fields";

export interface NetworkConfig {
  id: string;
  name: string;
  chainId: number;
  version: number;
  description: string;
  color: string;
  nodeUrl?: string;
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
    id: "devnet",
    name: "Devnet",
    chainId: 11155111,
    version: 1647720761,
    description: "Aztec Labs Devnet",
    color: "#2196f3",
    nodeUrl: "https://next.devnet.aztec-labs.com/",
  },
  {
    id: "nextnet",
    name: "Nextnet",
    chainId: 11155111,
    version: 4197971291,
    description: "Aztec Labs Nextnet",
    color: "#f321c9",
    nodeUrl: "https://nextnet.aztec-labs.com/",
  },
];

export const DEFAULT_NETWORK = NETWORKS[1];

export function getNetworkById(id: string): NetworkConfig | undefined {
  return NETWORKS.find((network) => network.id === id);
}

export function getNetworkByChainId(
  chainId: number,
  version?: number,
): NetworkConfig | undefined {
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
