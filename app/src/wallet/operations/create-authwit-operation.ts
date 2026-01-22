import {
  ExternalOperation,
  type PrepareResult,
  type PersistenceConfig,
} from "./base-operation";
import type { AztecAddress } from "@aztec/stdlib/aztec-address";
import type { AuthWitness } from "@aztec/stdlib/auth-witness";
import type {
  IntentInnerHash,
  CallIntent,
} from "@aztec/aztec.js/authorization";
import type { ChainInfo } from "@aztec/aztec.js/account";
import { Fr } from "@aztec/foundation/curves/bn254";
import {
  WalletInteraction,
  type WalletInteractionType,
} from "../types/wallet-interaction";
import type { InteractionManager } from "../managers/interaction-manager";
import type { AuthorizationManager } from "../managers/authorization-manager";
import type { DecodingCache } from "../decoding/decoding-cache";

// Arguments tuple for the operation
type CreateAuthWitArgs = [
  from: AztecAddress,
  messageHashOrIntent: IntentInnerHash | CallIntent,
];

// Result type for the operation
type CreateAuthWitResult = AuthWitness;

// Execution data stored between prepare and execute phases
interface CreateAuthWitExecutionData {
  from: AztecAddress;
  messageHashOrIntent: IntentInnerHash | CallIntent;
}

// Display data for authorization UI
type CreateAuthWitDisplayData = {
  from: string;
  type: "hash" | "call";
  hash?: string;
  call?: {
    caller: string;
    callerAlias: string;
    contract: string;
    contractName: string;
    function: string;
    args: string[];
  };
};

/**
 * CreateAuthWit operation implementation.
 *
 * Handles authwit creation with the following features:
 * - Decodes and displays the intent being authorized
 * - Shows what contract/function will be called
 * - Displays the caller (who can use this authwit)
 * - Requires explicit user approval
 * - NOT persistent (each authwit requires separate approval)
 */
export class CreateAuthWitOperation extends ExternalOperation<
  CreateAuthWitArgs,
  CreateAuthWitResult,
  CreateAuthWitExecutionData,
  CreateAuthWitDisplayData
> {
  protected interactionManager: InteractionManager;

  constructor(
    private decodingCache: DecodingCache,
    interactionManager: InteractionManager,
    private authorizationManager: AuthorizationManager,
    private createAuthWitInternal: (
      from: AztecAddress,
      messageHashOrIntent: IntentInnerHash | CallIntent,
      chainInfo: ChainInfo,
    ) => Promise<AuthWitness>,
    private chainInfo: ChainInfo,
  ) {
    super();
    this.interactionManager = interactionManager;
  }

  async check(
    _from: AztecAddress,
    _messageHashOrIntent: IntentInnerHash | CallIntent,
  ): Promise<CreateAuthWitResult | undefined> {
    // No early return - always requires authorization
    return undefined;
  }

  async createInteraction(
    from: AztecAddress,
    messageHashOrIntent: IntentInnerHash | CallIntent,
  ): Promise<WalletInteraction<WalletInteractionType>> {
    const interaction = WalletInteraction.from({
      type: "createAuthWit",
      status: "PREPARING",
      complete: false,
      title: "Create Authorization Witness",
      description: `From: ${from.toString()}`,
    });

    await this.interactionManager.storeAndEmit(interaction);

    return interaction;
  }

  async prepare(
    from: AztecAddress,
    messageHashOrIntent: IntentInnerHash | CallIntent,
  ): Promise<
    PrepareResult<
      CreateAuthWitResult,
      CreateAuthWitDisplayData,
      CreateAuthWitExecutionData
    >
  > {
    const displayData: CreateAuthWitDisplayData = {
      from: from.toString(),
      type: "hash",
    };

    // Check if it's a hash or a call intent
    if (messageHashOrIntent instanceof Fr) {
      // It's a hash
      displayData.type = "hash";
      displayData.hash = messageHashOrIntent.toString();
    } else {
      // It's a CallIntent
      const intent = messageHashOrIntent as CallIntent;
      displayData.type = "call";

      // Decode call information
      const callerAlias = await this.decodingCache.getAddressAlias(
        intent.caller,
      );
      const contractName = await this.decodingCache.getAddressAlias(
        intent.call.to,
      );

      displayData.call = {
        caller: intent.caller.toString(),
        callerAlias,
        contract: intent.call.to.toString(),
        contractName,
        function: intent.call.name,
        args: intent.call.args.map((arg) => arg.toString()),
      };
    }

    return {
      displayData,
      executionData: {
        from,
        messageHashOrIntent,
      },
      // NO persistence - each authwit requires separate approval
    };
  }

  async requestAuthorization(
    displayData: CreateAuthWitDisplayData,
    _persistence?: PersistenceConfig,
  ): Promise<void> {
    await this.emitProgress("REQUESTING AUTHORIZATION", undefined, false, {
      title: "Create Authorization Witness",
    });

    await this.authorizationManager.requestAuthorization([
      {
        id: crypto.randomUUID(),
        appId: this.authorizationManager.appId,
        method: "createAuthWit",
        params: displayData,
        timestamp: Date.now(),
      },
    ]);
  }

  async execute(
    executionData: CreateAuthWitExecutionData,
  ): Promise<CreateAuthWitResult> {
    const result = await this.createAuthWitInternal(
      executionData.from,
      executionData.messageHashOrIntent,
      this.chainInfo,
    );

    await this.emitProgress("SUCCESS", undefined, true);
    return result;
  }
}
