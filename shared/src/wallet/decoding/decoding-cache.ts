import type { PXE } from "@aztec/pxe/client/lazy";
import type { AztecNode } from "@aztec/aztec.js/node";
import { AztecAddress } from "@aztec/stdlib/aztec-address";
import type { Fr } from "@aztec/foundation/curves/bn254";
import type { ContractArtifact } from "@aztec/stdlib/abi";
import type { Aliased } from "@aztec/aztec.js/wallet";
import type { WalletDB } from "../database/wallet-db";
import type {
  ContractInstancePreimage,
  ContractInstancePreimageWithAddress,
} from "@aztec/stdlib/contract";

/**
 * Cache for contract metadata, artifacts, and address aliases to reduce expensive PXE queries.
 * Shared across CallAuthorizationFormatter and TxCallStackDecoder.
 *
 * IMPORTANT: This cache is designed to be IndexedDB-safe. It avoids interleaving
 * reads across different IndexedDB databases (wallet-db vs PXE) within the same
 * async call chain. Wallet-db data (accounts, senders) is loaded once and cached
 * in memory, so subsequent alias lookups never touch IndexedDB between PXE calls.
 */
export class DecodingCache {
  private instanceCache = new Map<string, ContractInstancePreimageWithAddress>();
  private artifactCache = new Map<string, ContractArtifact>();
  private addressAliasCache = new Map<string, string>();
  /** Memoized effective (current) contract class id per address, resolved from chain state. */
  private classIdCache = new Map<string, Fr>();

  /** Pre-loaded wallet-db data to avoid IndexedDB reads during PXE call chains */
  private accountsSnapshot: Aliased<AztecAddress>[] | null = null;
  private sendersSnapshot: Aliased<AztecAddress>[] | null = null;

  constructor(
    private pxe: PXE,
    private node: AztecNode,
    private db: WalletDB,
  ) {}

  /**
   * Get contract metadata (instance) for an address, with caching.
   */
  async getContractInstance(address: AztecAddress): Promise<ContractInstancePreimageWithAddress> {
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
   * Resolve the *effective* (current) contract class id for an address, with caching.
   *
   * `pxe.getContractInstance` only returns the immutable address preimage, whose
   * `originalContractClassId` is the class the contract was deployed with. If the contract has since
   * been upgraded, the code it currently runs — and thus the artifact needed to decode its calls —
   * belongs to a different class. That current class id is chain-tracked state, so we read it from the
   * node. We fall back to the preimage's original class id when the contract isn't published on-chain
   * (e.g. a purely local/private registration), where original and current are necessarily the same.
   */
  async getEffectiveContractClassId(address: AztecAddress): Promise<Fr> {
    const key = address.toString();

    const cached = this.classIdCache.get(key);
    if (cached) {
      return cached;
    }

    const publishedContract = await this.node.getContract(address);
    const classId =
      publishedContract?.currentContractClassId ??
      (await this.getContractInstance(address)).originalContractClassId;

    this.classIdCache.set(key, classId);
    return classId;
  }

  /**
   * Get the contract artifact for an address, resolving the current (upgrade-aware) class id.
   */
  async getContractArtifactForAddress(address: AztecAddress): Promise<ContractArtifact> {
    const classId = await this.getEffectiveContractClassId(address);
    return this.getContractArtifact(classId);
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
    if (!artifact) {
      throw new Error(`Contract artifact not found for class id ${key}`);
    }
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
   * Load accounts and senders from wallet-db into memory.
   * Called once so that getAddressAlias never needs to touch
   * IndexedDB between PXE calls (avoiding transaction conflicts).
   */
  private async ensureWalletDataLoaded(): Promise<void> {
    if (this.accountsSnapshot === null) {
      this.accountsSnapshot = await this.db.listAccounts();
    }
    if (this.sendersSnapshot === null) {
      this.sendersSnapshot = await this.db.listSenders();
    }
  }

  /**
   * Invalidate the cached wallet-db snapshots so they'll be
   * re-loaded on next access. Call after account/sender changes.
   */
  invalidateWalletData(): void {
    this.accountsSnapshot = null;
    this.sendersSnapshot = null;
  }

  /**
   * Get address alias with caching.
   * Checks accounts, senders, and contract metadata in order.
   *
   * Wallet-db data is loaded once and cached to avoid interleaving
   * IndexedDB reads across wallet-db and PXE stores.
   */
  async getAddressAlias(address: AztecAddress): Promise<string> {
    const key = address.toString();

    if (this.addressAliasCache.has(key)) {
      return this.addressAliasCache.get(key)!;
    }

    // Load wallet-db data into memory first (single IndexedDB access)
    await this.ensureWalletDataLoaded();

    // Check if it's an account (pure memory lookup now)
    const account = this.accountsSnapshot!.find((acc) => acc.item.equals(address));
    if (account) {
      this.addressAliasCache.set(key, account.alias);
      return account.alias;
    }

    // Check if it's a registered sender (pure memory lookup now)
    const sender = this.sendersSnapshot!.find((s) => s.item.equals(address));
    if (sender) {
      const alias = sender.alias.replace("senders:", "");
      this.addressAliasCache.set(key, alias);
      return alias;
    }

    // Try to get contract metadata for more info (PXE-only calls now, no wallet-db interleaving)
    try {
      const artifact = await this.getContractArtifactForAddress(address);
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
    instance: ContractInstancePreimage,
    artifact: ContractArtifact | undefined,
    address: AztecAddress,
  ): Promise<string> {
    // Try to get name from artifact parameter
    let contractName = artifact?.name;

    // Check if instanceData contains an artifact
    if (!contractName && typeof instance === "object" && "artifact" in instance) {
      contractName = (instance as any).artifact?.name;
    }

    // If we still don't have a name, try the artifact cache using the instance's contract class ID
    if (!contractName && instance?.originalContractClassId) {
      try {
        const cachedArtifact = await this.getContractArtifact(instance.originalContractClassId);
        if (cachedArtifact) {
          contractName = cachedArtifact.name;
        }
      } catch {
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
      } catch {
        // Ignore errors - we'll fall back to "Unknown Contract"
      }
    }

    return contractName || "Unknown Contract";
  }
}
