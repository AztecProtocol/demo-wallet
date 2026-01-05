import {
  ExternalOperation,
  type PrepareResult,
  type PersistenceConfig,
} from "./base-operation";
import type { AztecAddress } from "@aztec/stdlib/aztec-address";
import type { AuthWitness } from "@aztec/stdlib/auth-witness";
import type {
  UtilitySimulationResult,
  SimulationStats,
} from "@aztec/stdlib/tx";
import type { PXE } from "@aztec/pxe/server";
import {
  WalletInteraction,
  type WalletInteractionType,
} from "../types/wallet-interaction";
import type { WalletDB } from "../database/wallet-db";
import type { InteractionManager } from "../managers/interaction-manager";
import type { AuthorizationManager } from "../managers/authorization-manager";
import type { DecodingCache } from "../decoding/decoding-cache";
import { TxCallStackDecoder } from "../decoding/tx-callstack-decoder";
import { hashUtilityCall } from "../utils/simulation-utils";
import type { FunctionCall } from "@aztec/aztec.js/abi";

// Utility execution trace with decoded arguments and formatted result
interface UtilityExecutionTrace {
  functionName: string;
  args: unknown;
  contractAddress: string;
  contractName: string;
  result: string;
  isUtility: true;
}

// Arguments tuple for the operation
type SimulateUtilityArgs = [
  call: FunctionCall,
  authwits?: AuthWitness[],
  scopes?: AztecAddress[],
];

// Result type for the operation
type SimulateUtilityResult = UtilitySimulationResult;

// Execution data stored between prepare and execute phases
interface SimulateUtilityExecutionData {
  simulationResult: UtilitySimulationResult;
  executionTrace: UtilityExecutionTrace;
  payloadHash: string;
}

// Display data for authorization UI
type SimulateUtilityDisplayData = {
  payloadHash: string;
  executionTrace: UtilityExecutionTrace;
  title: string;
  contractName: string;
  stats?: SimulationStats;
} & Record<string, unknown>;

/**
 * SimulateUtility operation implementation.
 *
 * Handles utility function simulation with the following features:
 * - Simulates utility call with PXE
 * - Generates execution trace with decoded arguments
 * - Creates interaction for tracking
 * - Stores utility trace in database
 * - Supports persistent authorization based on payload hash
 */
export class SimulateUtilityOperation extends ExternalOperation<
  SimulateUtilityArgs,
  SimulateUtilityResult,
  SimulateUtilityExecutionData,
  SimulateUtilityDisplayData
> {
  protected interactionManager: InteractionManager;

  constructor(
    private pxe: PXE,
    private db: WalletDB,
    private decodingCache: DecodingCache,
    interactionManager: InteractionManager,
    private authorizationManager: AuthorizationManager
  ) {
    super();
    this.interactionManager = interactionManager;
  }

  async check(
    _call: FunctionCall,
    _authwits?: AuthWitness[],
    _scopes?: AztecAddress[]
  ): Promise<SimulateUtilityResult | undefined> {
    // No early return checks for this operation
    return undefined;
  }

  async createInteraction(
    call: FunctionCall,
    _authwits?: AuthWitness[],
    _scopes?: AztecAddress[]
  ): Promise<WalletInteraction<WalletInteractionType>> {
    // Create interaction with simple title from args only
    const payloadHash = hashUtilityCall(call);
    const contractName = await this.decodingCache.getAddressAlias(call.to);
    const title = `${contractName}.${call.name}`;
    const interaction = WalletInteraction.from({
      id: payloadHash,
      type: "simulateUtility",
      title,
      description: `Contract: ${call.to.toString()}`,
      complete: false,
      status: "SIMULATING",
      timestamp: Date.now(),
    });

    await this.interactionManager.storeAndEmit(interaction);

    return interaction;
  }

  async prepare(
    call: FunctionCall,
    authwits?: AuthWitness[],
    scopes?: AztecAddress[]
  ): Promise<
    PrepareResult<
      SimulateUtilityResult,
      SimulateUtilityDisplayData,
      SimulateUtilityExecutionData
    >
  > {
    // NO TRY-CATCH - let errors throw naturally!

    // Generate hash for deduplication
    const payloadHash = hashUtilityCall(call);

    // Simulate the utility function
    const simulationResult = await this.pxe.simulateUtility(
      call,
      authwits,
      scopes
    );

    // Get contract name for better display
    const contractName = await this.decodingCache.getAddressAlias(call.to);

    // Format arguments and result using the TxCallStackDecoder
    // Note: UtilitySimulationResult.result is now Fr[] (raw field elements)
    // We need to decode them using the function's return type ABI
    const decoder = new TxCallStackDecoder(this.decodingCache);

    // Format the input arguments (these come from FunctionCall.args which are already typed)
    const decodedArgs = await decoder.formatUtilityArguments(
      call.to,
      call.name,
      call.args
    );

    // Format the result (now an array of Fr that needs decoding based on return type)
    const formattedResult = await decoder.formatUtilityResult(
      call.to,
      call.name,
      simulationResult.result
    );

    const executionTrace = {
      functionName: call.name,
      args: decodedArgs,
      contractAddress: call.to.toString(),
      contractName,
      result: formattedResult,
      isUtility: true as const,
    };

    const title = `${contractName}.${call.name}`;

    // Store the utility trace and stats for display
    await this.db.storeUtilityTrace(
      payloadHash,
      executionTrace,
      simulationResult.stats
    );

    return {
      displayData: {
        payloadHash,
        executionTrace,
        title,
        contractName,
        stats: simulationResult.stats,
      },
      executionData: { simulationResult, executionTrace, payloadHash },
      persistence: {
        storageKey: `simulateUtility:${payloadHash}`,
        persistData: { title },
      },
    };
  }

  async requestAuthorization(
    displayData: SimulateUtilityDisplayData,
    persistence?: PersistenceConfig
  ): Promise<void> {
    // Update interaction with detailed title and status
    await this.emitProgress("REQUESTING AUTHORIZATION", undefined, false, {
      title: displayData.title,
    });

    // Request authorization with optional persistent caching
    await this.authorizationManager.requestAuthorization([
      {
        id: crypto.randomUUID(),
        appId: this.authorizationManager.appId,
        method: "simulateUtility",
        params: {
          payloadHash: displayData.payloadHash,
          executionTrace: displayData.executionTrace,
          isUtility: true,
          stats: displayData.stats,
        },
        timestamp: Date.now(),
        persistence,
      },
    ]);
  }

  async execute(
    executionData: SimulateUtilityExecutionData
  ): Promise<SimulateUtilityResult> {
    // Execution is just returning the simulation result
    // The actual simulation happened in prepare phase
    await this.emitProgress("SUCCESS", undefined, true);
    return executionData.simulationResult;
  }
}
