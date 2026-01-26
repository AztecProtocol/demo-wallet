import {
  ExternalOperation,
  type PrepareResult,
  type PersistenceConfig,
} from "./base-operation";
import type { ContractClassMetadata } from "@aztec/aztec.js/wallet";
import { Fr } from "@aztec/foundation/curves/bn254";
import {
  WalletInteraction,
  type WalletInteractionType,
} from "../types/wallet-interaction";
import type { InteractionManager } from "../managers/interaction-manager";
import type { AuthorizationManager } from "../managers/authorization-manager";

// Arguments tuple for the operation
type GetContractClassMetadataArgs = [id: Fr];

// Result type for the operation
type GetContractClassMetadataResult = ContractClassMetadata;

// Execution data stored between prepare and execute phases
interface GetContractClassMetadataExecutionData {
  id: Fr;
  metadata: ContractClassMetadata;
}

// Display data for authorization UI
type GetContractClassMetadataDisplayData = {
  contractClassId: string;
  artifactName?: string;
  isArtifactRegistered: boolean;
  isPubliclyRegistered: boolean;
};

/**
 * GetContractClassMetadata operation implementation.
 *
 * PRIVACY CONCERN: Revealing whether a contract artifact is registered
 * discloses information about what contracts the user has interacted with.
 *
 * Handles contract class metadata access with the following features:
 * - Queries PXE for contract class metadata
 * - Shows artifact name if available
 * - Shows user what information will be revealed
 * - Can be made persistent for specific contract classes
 */
export class GetContractClassMetadataOperation extends ExternalOperation<
  GetContractClassMetadataArgs,
  GetContractClassMetadataResult,
  GetContractClassMetadataExecutionData,
  GetContractClassMetadataDisplayData
> {
  protected interactionManager: InteractionManager;

  constructor(
    private getContractClassMetadata: (id: Fr) => Promise<ContractClassMetadata>,
    interactionManager: InteractionManager,
    private authorizationManager: AuthorizationManager,
  ) {
    super();
    this.interactionManager = interactionManager;
  }

  async check(
    _id: Fr,
  ): Promise<GetContractClassMetadataResult | undefined> {
    // No early return - always requires authorization
    return undefined;
  }

  async createInteraction(
    id: Fr,
  ): Promise<WalletInteraction<WalletInteractionType>> {
    const interaction = WalletInteraction.from({
      type: "getContractClassMetadata",
      status: "PREPARING",
      complete: false,
      title: "Get Contract Class Metadata",
      description: `Class ID: ${id.toString().slice(0, 16)}...`,
    });

    await this.interactionManager.storeAndEmit(interaction);

    return interaction;
  }

  async prepare(
    id: Fr,
  ): Promise<
    PrepareResult<
      GetContractClassMetadataResult,
      GetContractClassMetadataDisplayData,
      GetContractClassMetadataExecutionData
    >
  > {
    // Query metadata
    const metadata = await this.getContractClassMetadata(id);

    // Try to get artifact name
    // Note: The artifact field is not included in ContractClassMetadata type,
    // so we cannot extract the artifact name here. The PXE may have it internally
    // but it's not exposed through this interface.
    const artifactName: string | undefined = undefined;

    const displayData: GetContractClassMetadataDisplayData = {
      contractClassId: id.toString(),
      artifactName,
      isArtifactRegistered: metadata.isArtifactRegistered,
      isPubliclyRegistered: metadata.isContractClassPubliclyRegistered,
    };

    return {
      displayData,
      executionData: {
        id,
        metadata,
      },
      // Can be made persistent per contract class
      persistence: {
        storageKey: `getContractClassMetadata:${id.toString()}`,
        persistData: null,
      },
    };
  }

  async requestAuthorization(
    displayData: GetContractClassMetadataDisplayData,
    persistence?: PersistenceConfig,
  ): Promise<void> {
    await this.emitProgress("REQUESTING AUTHORIZATION", undefined, false, {
      title: `Get Contract Class Metadata${displayData.artifactName ? `: ${displayData.artifactName}` : ""}`,
    });

    await this.authorizationManager.requestAuthorization([
      {
        id: crypto.randomUUID(),
        appId: this.authorizationManager.appId,
        method: "getContractClassMetadata",
        params: displayData,
        timestamp: Date.now(),
        persistence,
      },
    ]);
  }

  async execute(
    executionData: GetContractClassMetadataExecutionData,
  ): Promise<GetContractClassMetadataResult> {
    await this.emitProgress("SUCCESS", undefined, true);
    return executionData.metadata;
  }
}
