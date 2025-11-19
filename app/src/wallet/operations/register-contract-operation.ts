import {
  ExternalOperation,
  type PrepareResult,
  type PersistenceConfig,
} from "./base-operation";
import { AztecAddress } from "@aztec/stdlib/aztec-address";
import type {
  ContractInstanceWithAddress,
  ContractInstantiationData,
} from "@aztec/stdlib/contract";
import {
  getContractInstanceFromInstantiationParams,
  computePartialAddress,
  getContractClassFromArtifact,
} from "@aztec/stdlib/contract";
import type { ContractArtifact } from "@aztec/stdlib/abi";
import type { Fr } from "@aztec/foundation/fields";
import type { PXE } from "@aztec/pxe/server";
import {
  WalletInteraction,
  type WalletInteractionType,
} from "../types/wallet-interaction";
import type { DecodingCache } from "../decoding/decoding-cache";
import type { InteractionManager } from "../managers/interaction-manager";
import type { AuthorizationManager } from "../managers/authorization-manager";

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
    private authorizationManager: AuthorizationManager
  ) {
    super();
    this.interactionManager = interactionManager;
  }

  async check(
    instance: ContractInstanceWithAddress,
    artifact?: ContractArtifact,
    _secretKey?: Fr
  ): Promise<RegisterContractResult | undefined> {
    // Resolve contract address
    const contractAddress = instance.address;

    // Check if already registered (early return case)
    const metadata = await this.pxe.getContractMetadata(contractAddress);
    if (metadata.contractInstance) {
      return metadata.contractInstance; // Early return - no interaction created
    }

    return undefined; // Continue with normal flow
  }

  async createInteraction(
    instance: ContractInstanceWithAddress,
    artifact?: ContractArtifact,
    _secretKey?: Fr
  ): Promise<WalletInteraction<WalletInteractionType>> {
    // Create interaction with simple title from args only
    const contractAddress = instance.address;

    const contractName = await this.decodingCache.resolveContractName(
      instance,
      artifact,
      contractAddress
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
    secretKey?: Fr
  ): Promise<
    PrepareResult<
      RegisterContractResult,
      RegisterContractDisplayData,
      RegisterContractExecutionData
    >
  > {
    // Resolve contract address
    const contractAddress = instance.address;
    // Resolve contract name for display
    const contractName = await this.decodingCache.resolveContractName(
      instance,
      artifact,
      contractAddress
    );

    return {
      displayData: { contractAddress, contractName },
      executionData: { instance, artifact, secretKey },
    };
  }

  async requestAuthorization(
    displayData: RegisterContractDisplayData,
    _persistence?: PersistenceConfig
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
    executionData: RegisterContractExecutionData
  ): Promise<RegisterContractResult> {
    let { instance, artifact, secretKey } = executionData;
    const { contractInstance: existingInstance } =
      await this.pxe.getContractMetadata(instance.address);

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
        const classMetadata = await this.pxe.getContractClassMetadata(
          instance.currentContractClassId,
          true
        );
        if (!classMetadata.artifact) {
          throw new Error(
            `Cannot register contract at ${instance.address.toString()}: artifact is required but not provided, and wallet does not have the artifact for contract class ${instance.currentContractClassId.toString()}`
          );
        }
        artifact = classMetadata.artifact;
      }
      await this.pxe.registerContract({ artifact, instance });
    }

    if (secretKey) {
      await this.pxe.registerAccount(
        secretKey,
        await computePartialAddress(instance)
      );
    }

    await this.emitProgress("SUCCESS", undefined, true);
    return instance;
  }
}
