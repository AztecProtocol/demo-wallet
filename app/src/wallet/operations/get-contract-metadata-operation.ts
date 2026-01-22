import {
  ExternalOperation,
  type PrepareResult,
  type PersistenceConfig,
} from "./base-operation";
import type { AztecAddress } from "@aztec/stdlib/aztec-address";
import type { ContractMetadata } from "@aztec/aztec.js/wallet";
import type { PXE } from "@aztec/pxe/server";
import {
  WalletInteraction,
  type WalletInteractionType,
} from "../types/wallet-interaction";
import type { InteractionManager } from "../managers/interaction-manager";
import type { AuthorizationManager } from "../managers/authorization-manager";
import type { DecodingCache } from "../decoding/decoding-cache";

// Arguments tuple for the operation
type GetContractMetadataArgs = [address: AztecAddress];

// Result type for the operation
type GetContractMetadataResult = ContractMetadata;

// Execution data stored between prepare and execute phases
interface GetContractMetadataExecutionData {
  address: AztecAddress;
  metadata: ContractMetadata;
}

// Display data for authorization UI
type GetContractMetadataDisplayData = {
  address: string;
  contractName: string;
  isRegistered: boolean;
  isInitialized: boolean;
  isPublished: boolean;
};

/**
 * GetContractMetadata operation implementation.
 *
 * PRIVACY CONCERN: Revealing whether a contract is registered in the wallet
 * discloses information about user's interactions and interests.
 *
 * Handles contract metadata access with the following features:
 * - Queries PXE for contract metadata
 * - Decodes contract name if available
 * - Shows user what information will be revealed
 * - Can be made persistent for specific contracts
 */
export class GetContractMetadataOperation extends ExternalOperation<
  GetContractMetadataArgs,
  GetContractMetadataResult,
  GetContractMetadataExecutionData,
  GetContractMetadataDisplayData
> {
  protected interactionManager: InteractionManager;

  constructor(
    private pxe: PXE,
    private decodingCache: DecodingCache,
    interactionManager: InteractionManager,
    private authorizationManager: AuthorizationManager,
  ) {
    super();
    this.interactionManager = interactionManager;
  }

  async check(
    _address: AztecAddress,
  ): Promise<GetContractMetadataResult | undefined> {
    // No early return - always requires authorization
    return undefined;
  }

  async createInteraction(
    address: AztecAddress,
  ): Promise<WalletInteraction<WalletInteractionType>> {
    const interaction = WalletInteraction.from({
      type: "getContractMetadata",
      status: "PREPARING",
      complete: false,
      title: "Get Contract Metadata",
      description: `Contract: ${address.toString().slice(0, 16)}...`,
    });

    await this.interactionManager.storeAndEmit(interaction);

    return interaction;
  }

  async prepare(
    address: AztecAddress,
  ): Promise<
    PrepareResult<
      GetContractMetadataResult,
      GetContractMetadataDisplayData,
      GetContractMetadataExecutionData
    >
  > {
    // Query metadata
    const metadata = await this.pxe.getContractMetadata(address);

    // Try to get contract name
    const contractName = await this.decodingCache.getAddressAlias(address);

    const displayData: GetContractMetadataDisplayData = {
      address: address.toString(),
      contractName,
      isRegistered: !!metadata.instance,
      isInitialized: metadata.isContractInitialized,
      isPublished: metadata.isContractPublished,
    };

    return {
      displayData,
      executionData: {
        address,
        metadata,
      },
      // Can be made persistent per contract
      persistence: {
        storageKey: `getContractMetadata:${address.toString()}`,
        persistData: null,
      },
    };
  }

  async requestAuthorization(
    displayData: GetContractMetadataDisplayData,
    persistence?: PersistenceConfig,
  ): Promise<void> {
    await this.emitProgress("REQUESTING AUTHORIZATION", undefined, false, {
      title: `Get Contract Metadata: ${displayData.contractName}`,
    });

    await this.authorizationManager.requestAuthorization([
      {
        id: crypto.randomUUID(),
        appId: this.authorizationManager.appId,
        method: "getContractMetadata",
        params: displayData,
        timestamp: Date.now(),
        persistence,
      },
    ]);
  }

  async execute(
    executionData: GetContractMetadataExecutionData,
  ): Promise<GetContractMetadataResult> {
    await this.emitProgress("SUCCESS", undefined, true);
    return executionData.metadata;
  }
}
