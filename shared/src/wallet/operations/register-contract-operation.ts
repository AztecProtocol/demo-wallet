import { ExternalOperation, type PrepareResult, type PersistenceConfig } from "./base-operation";
import { AztecAddress } from "@aztec/stdlib/aztec-address";
import type {
  ContractInstancePreimage,
  ContractInstancePreimageWithAddress,
} from "@aztec/stdlib/contract";
import {
  computeContractAddressFromInstance,
  computePartialAddress,
  getContractClassFromArtifact,
} from "@aztec/stdlib/contract";
import type { ContractArtifact } from "@aztec/stdlib/abi";
import { Fr } from "@aztec/foundation/curves/bn254";
import {
  deriveKeys,
  deriveKeysFromMasterSecretKeys,
  type MasterSecretKeys,
} from "@aztec/stdlib/keys";
import type { PXE } from "@aztec/pxe/client/lazy";
import { WalletInteraction, type WalletInteractionType } from "../types/wallet-interaction";
import type { DecodingCache } from "../decoding/decoding-cache";
import type { InteractionManager } from "../managers/interaction-manager";
import type { AuthorizationManager } from "../managers/authorization-manager";
import type { WalletDB } from "../database/wallet-db";

// Arguments tuple for the operation
type RegisterContractArgs = [
  instance: ContractInstancePreimage,
  artifact?: ContractArtifact,
  secretKeyOrKeys?: Fr | MasterSecretKeys,
];

// Result type for the operation
type RegisterContractResult = ContractInstancePreimageWithAddress;

// Execution data stored between prepare and execute phases
interface RegisterContractExecutionData {
  instance: ContractInstancePreimage;
  artifact?: ContractArtifact;
  secretKeyOrKeys?: Fr | MasterSecretKeys;
}

// Display data for authorization UI
type RegisterContractDisplayData = {
  contractAddress: AztecAddress;
  contractName: string;
} & Record<string, unknown>;

/**
 * RegisterContract operation implementation.
 *
 * Handles contract registration with the following features:
 * - Checks if contract is already registered (early return)
 * - Resolves contract name for display
 * - Registers contract with PXE
 */
export class RegisterContractOperation extends ExternalOperation<
  RegisterContractArgs,
  RegisterContractResult,
  RegisterContractExecutionData,
  RegisterContractDisplayData
> {
  protected interactionManager: InteractionManager;

  constructor(
    private pxe: PXE,
    private decodingCache: DecodingCache,
    interactionManager: InteractionManager,
    private authorizationManager: AuthorizationManager,
    private db: WalletDB,
  ) {
    super();
    this.interactionManager = interactionManager;
  }

  async check(
    instance: ContractInstancePreimage,
    artifact?: ContractArtifact,
    _secretKeyOrKeys?: Fr | MasterSecretKeys,
  ): Promise<RegisterContractResult | undefined> {
    // Cache artifact early for batch operations
    // Uses instance.originalContractClassId as key (no expensive computation)
    if (artifact && instance.originalContractClassId) {
      this.decodingCache.cacheArtifactForBatch(instance.originalContractClassId, artifact);
    }

    // Resolve contract address from the instance preimage
    const contractAddress = await computeContractAddressFromInstance(instance);

    // Check if already registered (early return case)
    const storedInstance = await this.pxe.getContractInstance(contractAddress);
    if (storedInstance) {
      return storedInstance; // Early return - no interaction created
    }

    return undefined; // Continue with normal flow
  }

  async createInteraction(
    instance: ContractInstancePreimage,
    artifact?: ContractArtifact,
    _secretKeyOrKeys?: Fr | MasterSecretKeys,
  ): Promise<WalletInteraction<WalletInteractionType>> {
    // Create interaction with simple title from args only
    const contractAddress = await computeContractAddressFromInstance(instance);

    const contractName = await this.decodingCache.resolveContractName(
      instance,
      artifact,
      contractAddress,
    );

    const interaction = WalletInteraction.from({
      type: "registerContract",
      status: "PREPARING",
      complete: false,
      title: `Register ${contractName}`,
      description: `Address: ${contractAddress.toString()}`,
    });

    await this.interactionManager.storeAndEmit(interaction);

    return interaction;
  }

  async prepare(
    instance: ContractInstancePreimage,
    artifact?: ContractArtifact,
    secretKeyOrKeys?: Fr | MasterSecretKeys,
  ): Promise<PrepareResult<RegisterContractDisplayData, RegisterContractExecutionData>> {
    // Resolve contract address from the instance preimage
    const contractAddress = await computeContractAddressFromInstance(instance);

    // Resolve contract name for display
    // This will now use the batch-cached artifacts if available
    const contractName = await this.decodingCache.resolveContractName(
      instance,
      artifact,
      contractAddress,
    );

    return {
      displayData: { contractAddress, contractName },
      executionData: { instance, artifact, secretKeyOrKeys },
      persistence: {
        storageKey: `registerContract:${contractAddress.toString()}`,
        persistData: null,
      },
    };
  }

  async requestAuthorization(
    displayData: RegisterContractDisplayData,
    _persistence?: PersistenceConfig,
  ): Promise<void> {
    // Update interaction with detailed title and status
    await this.emitProgress("REQUESTING AUTHORIZATION");

    await this.authorizationManager.requestAuthorization([
      {
        id: crypto.randomUUID(),
        appId: this.authorizationManager.appId,
        method: "registerContract",
        params: {
          contractAddress: displayData.contractAddress,
          contractName: displayData.contractName,
        },
        timestamp: Date.now(),
        // Persistence config for capability checking
        persistence: {
          storageKey: `registerContract:${displayData.contractAddress.toString()}`,
          persistData: null,
        },
      },
    ]);
  }

  async execute(executionData: RegisterContractExecutionData): Promise<RegisterContractResult> {
    const { instance, secretKeyOrKeys } = executionData;
    let { artifact } = executionData;

    const contractAddress = await computeContractAddressFromInstance(instance);
    const existingInstance = await this.pxe.getContractInstance(contractAddress);

    if (!existingInstance) {
      // Instance not registered yet
      if (!artifact) {
        // Try to get the artifact from the wallet's contract class storage
        const existingArtifact = await this.pxe.getContractArtifact(
          instance.originalContractClassId,
        );
        if (!existingArtifact) {
          throw new Error(
            `Cannot register contract at ${contractAddress.toString()}: artifact is required but not provided, and wallet does not have the artifact for contract class ${instance.originalContractClassId.toString()}`,
          );
        }
        artifact = existingArtifact;
      }
      // Register the contract class and instance independently. The instance's current class id
      // is chain-tracked state derived by PXE, so there is no separate manual "update" step.
      await this.pxe.registerContractClass(artifact);
      await this.pxe.registerContract(instance);
    }
    // If already registered we leave it untouched: contract upgrades are tracked from chain state.

    if (secretKeyOrKeys) {
      // PXE stores the derived privacy keys, not the account seed, so derive them here before
      // registering the account against the instance's partial address.
      const derivedKeys =
        secretKeyOrKeys instanceof Fr
          ? await deriveKeys(secretKeyOrKeys)
          : await deriveKeysFromMasterSecretKeys(secretKeyOrKeys);
      await this.pxe.registerAccount(derivedKeys, await computePartialAddress(instance));
    }

    // Automatically grant persistent authorizations for metadata queries
    // This allows apps that register a contract to query its metadata without additional prompts
    const appId = this.authorizationManager.appId;
    await this.db.storePersistentAuthorization(
      appId,
      `getContractMetadata:${contractAddress.toString()}`,
      null,
    );

    // Store getContractClassMetadata permission by contract CLASS ID (not address)
    // This matches the ContractClassesCapability specification
    if (artifact) {
      const contractClass = await getContractClassFromArtifact(artifact);
      await this.db.storePersistentAuthorization(
        appId,
        `getContractClassMetadata:${contractClass.id.toString()}`,
        null,
      );
    }

    await this.emitProgress("SUCCESS", undefined, true);
    return existingInstance ?? { ...instance, address: contractAddress };
  }
}
