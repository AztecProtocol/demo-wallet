import type { PXE } from "@aztec/pxe/server";
import { AztecAddress } from "@aztec/stdlib/aztec-address";
import type { ContractArtifact } from "@aztec/stdlib/abi";
import type { WalletDB } from "../database/wallet-db";
import type { ContractInstanceWithAddress } from "@aztec/stdlib/contract";

interface ContractMetadata {
  contractInstance?: {
    currentContractClassId: any;
  };
}

/**
 * Cache for contract metadata, artifacts, and address aliases to reduce expensive PXE queries.
 * Shared across CallAuthorizationFormatter and TxCallStackDecoder.
 */
export class DecodingCache {
  private instanceCache = new Map<string, ContractInstanceWithAddress>();
  private artifactCache = new Map<string, ContractArtifact>();
  private addressAliasCache = new Map<string, string>();

  constructor(
    private pxe: PXE,
    private db: WalletDB,
  ) {}

  /**
   * Get contract metadata (instance) for an address, with caching.
   */
  async getContractInstance(
    address: AztecAddress,
  ): Promise<ContractInstanceWithAddress> {
    const key = address.toString();

    if (this.instanceCache.has(key)) {
      return this.instanceCache.get(key)!;
    }

    const instance = await this.pxe.getContractInstance(address);
    if (!instance) {
      throw new Error(`Contract instance not found for address ${address.toString()}`);
    }
    this.instanceCache.set(key, instance);
    return instance;
  }

  /**
   * Get contract artifact for a contract class ID, with caching.
   */
  async getContractArtifact(contractClassId: any): Promise<ContractArtifact> {
    const key = contractClassId.toString();

    if (this.artifactCache.has(key)) {
      return this.artifactCache.get(key)!;
    }

    const artifact = await this.pxe.getContractArtifact(contractClassId);
    this.artifactCache.set(key, artifact);
    return artifact;
  }

  /**
   * Manually cache an artifact for batch operations.
   * This allows artifacts from earlier operations in a batch to be available
   * for decoding in later operations, without persisting to PXE.
   */
  cacheArtifactForBatch(contractClassId: any, artifact: ContractArtifact): void {
    const key = contractClassId.toString();
    this.artifactCache.set(key, artifact);
  }

  /**
   * Get address alias with caching.
   * Checks accounts, senders, and contract metadata in order.
   */
  async getAddressAlias(address: AztecAddress): Promise<string> {
    const key = address.toString();

    if (this.addressAliasCache.has(key)) {
      return this.addressAliasCache.get(key)!;
    }

    // Check if it's an account
    const accounts = await this.db.listAccounts();
    const account = accounts.find((acc) => acc.item.equals(address));
    if (account) {
      this.addressAliasCache.set(key, account.alias);
      return account.alias;
    }

    // Check if it's a registered sender (contact)
    const senders = await this.db.listSenders();
    const sender = senders.find((s) => s.item.equals(address));
    if (sender) {
      const alias = sender.alias.replace("senders:", "");
      this.addressAliasCache.set(key, alias);
      return alias;
    }

    // Try to get contract metadata for more info
    try {
      const instance = await this.getContractInstance(address);
      const artifact = await this.getContractArtifact(
        instance.currentContractClassId,
      );
      if (artifact) {
        this.addressAliasCache.set(key, artifact.name);
        return artifact.name;
      }
    } catch {
      // Ignore errors, use shortened address
    }

    // Return shortened address if no alias found
    // NOTE: We do NOT cache the shortened address fallback because the contract
    // might be registered later, and we want to be able to resolve its name then
    const shortAddress = `${address.toString().slice(0, 10)}...${address.toString().slice(-8)}`;
    return shortAddress;
  }

  /**
   * Resolve contract name from various sources.
   * Uses caching internally via getAddressAlias and getContractArtifact.
   */
  async resolveContractName(
    instance: ContractInstanceWithAddress,
    artifact: ContractArtifact | undefined,
    address: AztecAddress,
  ): Promise<string> {
    // Try to get name from artifact parameter
    let contractName = artifact?.name;

    // Check if instanceData contains an artifact
    if (
      !contractName &&
      typeof instance === "object" &&
      "artifact" in instance
    ) {
      contractName = (instance as any).artifact?.name;
    }

    // If we still don't have a name, try the artifact cache using the instance's contract class ID
    if (!contractName && instance?.currentContractClassId) {
      try {
        const cachedArtifact = await this.getContractArtifact(
          instance.currentContractClassId,
        );
        if (cachedArtifact) {
          contractName = cachedArtifact.name;
        }
      } catch (error) {
        // Artifact not in cache or PXE, continue to next method
      }
    }

    // If still no name, try to get alias from other sources (accounts, senders)
    if (!contractName) {
      try {
        const alias = await this.getAddressAlias(address);
        // getAddressAlias returns shortened address if no name found
        // Only use it if it's not a shortened address
        if (!alias.includes("...")) {
          contractName = alias;
        }
      } catch (error) {
        // Ignore errors - we'll fall back to "Unknown Contract"
      }
    }

    return contractName || "Unknown Contract";
  }
}
