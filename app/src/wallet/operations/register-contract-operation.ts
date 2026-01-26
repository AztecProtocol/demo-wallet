import {
  ExternalOperation,
  type PrepareResult,
  type PersistenceConfig,
} from "./base-operation";
import { AztecAddress } from "@aztec/stdlib/aztec-address";
import type { ContractInstanceWithAddress } from "@aztec/stdlib/contract";
import {
  computePartialAddress,
  getContractClassFromArtifact,
} from "@aztec/stdlib/contract";
import type { ContractArtifact } from "@aztec/stdlib/abi";
import type { Fr } from "@aztec/foundation/curves/bn254";
import type { PXE } from "@aztec/pxe/server";
import {
  WalletInteraction,
  type WalletInteractionType,
} from "../types/wallet-interaction";
import type { DecodingCache } from "../decoding/decoding-cache";
import type { InteractionManager } from "../managers/interaction-manager";
import type { AuthorizationManager } from "../managers/authorization-manager";
import type { WalletDB } from "../database/wallet-db";

// Arguments tuple for the operation
type RegisterContractArgs = [
  instance: ContractInstanceWithAddress,
  artifact?: ContractArtifact,
  secretKey?: Fr,
];

// Result type for the operation
type RegisterContractResult = ContractInstanceWithAddress;

// Execution data stored between prepare and execute phases
interface RegisterContractExecutionData {
  instance: ContractInstanceWithAddress;
  artifact?: ContractArtifact;
  secretKey?: Fr;
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
    instance: ContractInstanceWithAddress,
    artifact?: ContractArtifact,
    _secretKey?: Fr,
  ): Promise<RegisterContractResult | undefined> {
    // Resolve contract address
    const contractAddress = instance.address;

    // Check if already registered (early return case)
    const storedInstance = await this.pxe.getContractInstance(contractAddress);
    if (storedInstance) {
      return storedInstance; // Early return - no interaction created
    }

    return undefined; // Continue with normal flow
  }

  async createInteraction(
    instance: ContractInstanceWithAddress,
    artifact?: ContractArtifact,
    _secretKey?: Fr,
  ): Promise<WalletInteraction<WalletInteractionType>> {
    // Create interaction with simple title from args only
    const contractAddress = instance.address;

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
    instance: ContractInstanceWithAddress,
    artifact?: ContractArtifact,
    secretKey?: Fr,
  ): Promise<
    PrepareResult<
      RegisterContractResult,
      RegisterContractDisplayData,
      RegisterContractExecutionData
    >
  > {
    // Resolve contract address
    const contractAddress = instance.address;

    // CRITICAL FOR BATCH OPERATIONS:
    // If artifact is provided, cache it in the decoding cache so that subsequent
    // operations in the same batch can use it for display purposes.
    // This is safe because it's just a temporary cache for decoding, not registration.
    if (artifact) {
      const contractClass = await getContractClassFromArtifact(artifact);
      this.decodingCache.cacheArtifactForBatch(contractClass.id, artifact);
    }

    // Resolve contract name for display
    // This will now use the batch-cached artifacts if available
    const contractName = await this.decodingCache.resolveContractName(
      instance,
      artifact,
      contractAddress,
    );

    return {
      displayData: { contractAddress, contractName },
      executionData: { instance, artifact, secretKey },
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
      },
    ]);
  }

  async execute(
    executionData: RegisterContractExecutionData,
  ): Promise<RegisterContractResult> {
    let { instance, artifact, secretKey } = executionData;
    const existingInstance = await this.pxe.getContractInstance(
      instance.address,
    );

    if (existingInstance) {
      // Instance already registered in the wallet
      if (artifact) {
        const thisContractClass = await getContractClassFromArtifact(artifact);
        if (
          !thisContractClass.id.equals(existingInstance.currentContractClassId)
        ) {
          // wallet holds an outdated version of this contract
          await this.pxe.updateContract(instance.address, artifact);
          instance.currentContractClassId = thisContractClass.id;
        }
      }
      // If no artifact provided, we just use the existing registration
    } else {
      // Instance not registered yet
      if (!artifact) {
        // Try to get the artifact from the wallet's contract class storage
        const existingArtifact = await this.pxe.getContractArtifact(
          instance.currentContractClassId,
        );
        if (!existingArtifact) {
          throw new Error(
            `Cannot register contract at ${instance.address.toString()}: artifact is required but not provided, and wallet does not have the artifact for contract class ${instance.currentContractClassId.toString()}`,
          );
        }
        artifact = existingArtifact;
      }
      await this.pxe.registerContract({ artifact, instance });
    }

    if (secretKey) {
      await this.pxe.registerAccount(
        secretKey,
        await computePartialAddress(instance),
      );
    }

    // Automatically grant persistent authorizations for metadata queries
    // This allows apps that register a contract to query its metadata without additional prompts
    const appId = this.authorizationManager.appId;
    await this.db.storePersistentAuthorization(
      appId,
      `getContractMetadata:${instance.address.toString()}`,
      null,
    );
    await this.db.storePersistentAuthorization(
      appId,
      `getContractClassMetadata:${instance.currentContractClassId.toString()}`,
      null,
    );

    await this.emitProgress("SUCCESS", undefined, true);
    return instance;
  }
}
