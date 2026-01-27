import {
  ExternalOperation,
  type PrepareResult,
  type PersistenceConfig,
} from "./base-operation";
import type { AztecAddress } from "@aztec/stdlib/aztec-address";
import { TxHash } from "@aztec/stdlib/tx";
import type { PXE } from "@aztec/pxe/server";
import type { ExecutionPayload, TxExecutionRequest } from "@aztec/stdlib/tx";
import { waitForTx, type AztecNode } from "@aztec/aztec.js/node";
import { inspect } from "util";
import {
  WalletInteraction,
  type WalletInteractionType,
} from "../types/wallet-interaction";
import type { InteractionManager } from "../managers/interaction-manager";
import type { AuthorizationManager } from "../managers/authorization-manager";
import type { DecodingCache } from "../decoding/decoding-cache";
import type { ReadableCallAuthorization } from "../decoding/call-authorization-formatter";
import type { DecodedExecutionTrace } from "../decoding/tx-callstack-decoder";
import {
  hashExecutionPayload,
  generateSimulationTitle,
} from "../utils/simulation-utils";
import type { SendOptions } from "@aztec/aztec.js/wallet";
import { NO_WAIT, type InteractionWaitOptions, type SendReturn } from "@aztec/aztec.js/contracts";
import type { SimulateTxOperation } from "./simulate-tx-operation";
import type { AuthWitness } from "@aztec/stdlib/auth-witness";
import type { CallIntent } from "@aztec/aztec.js/authorization";
import type { GasSettings } from "@aztec/stdlib/gas";
import type { FieldsOf } from "@aztec/foundation/types";
import { serializePrivateExecutionSteps } from "@aztec/stdlib/kernel";
import type { FeeOptions } from "@aztec/wallet-sdk/base-wallet";

// Arguments tuple for the operation (with generic for wait type)
type SendTxArgs<W extends InteractionWaitOptions = undefined> = [
  executionPayload: ExecutionPayload,
  opts: SendOptions<W>
];

// Result type for the operation (conditional based on wait)
type SendTxResult<W extends InteractionWaitOptions = undefined> = SendReturn<W>;

// Execution data stored between prepare and execute phases
interface SendTxExecutionData<W extends InteractionWaitOptions = undefined> {
  txRequest: TxExecutionRequest;
  wait: W;
}

// Display data for authorization UI
type SendTxDisplayData = {
  payloadHash: string;
  title: string;
  from: AztecAddress;
  callAuthorizations: ReadableCallAuthorization[];
  executionTrace?: DecodedExecutionTrace;
  stats?: any;
  embeddedPaymentMethodFeePayer?: AztecAddress;
};

/**
 * SendTx operation implementation.
 *
 * Handles transaction sending with the following features:
 * - Reuses simulation from simulateTx operation
 * - Creates auth witnesses for call authorizations
 * - Parallel proving optimization (starts proving while awaiting user authorization)
 * - Transaction proving and sending
 * - Comprehensive interaction tracking with status updates
 * - Error handling with descriptive status messages
 * - Support for wait options (NO_WAIT for immediate TxHash, or wait for TxReceipt)
 */
export class SendTxOperation<W extends InteractionWaitOptions = undefined> extends ExternalOperation<
  SendTxArgs<W>,
  SendTxResult<W>,
  SendTxExecutionData<W>,
  SendTxDisplayData
> {
  protected interactionManager: InteractionManager;

  constructor(
    private pxe: PXE,
    private aztecNode: AztecNode,
    private decodingCache: DecodingCache,
    interactionManager: InteractionManager,
    private authorizationManager: AuthorizationManager,
    private simulateTxOp: SimulateTxOperation,
    private createAuthWit: (
      from: AztecAddress,
      auth: CallIntent,
    ) => Promise<AuthWitness>,
    private createTxExecutionRequestFromPayloadAndFee: (
      exec: ExecutionPayload,
      from: AztecAddress,
      fee: FeeOptions,
    ) => Promise<TxExecutionRequest>,
    private completeFeeOptions: (
      from: AztecAddress,
      feePayer: AztecAddress | undefined,
      gasSettings?: Partial<FieldsOf<GasSettings>>,
    ) => Promise<FeeOptions>,
    private contextualizeError: (err: unknown, context: string) => Error,
  ) {
    super();
    this.interactionManager = interactionManager;
  }

  async check(
    _executionPayload: ExecutionPayload,
    _opts: SendOptions<W>,
  ): Promise<SendTxResult<W> | undefined> {
    // No early return checks for this operation
    return undefined;
  }

  async createInteraction(
    executionPayload: ExecutionPayload,
    opts: SendOptions<W>,
  ): Promise<WalletInteraction<WalletInteractionType>> {
    // Create interaction with simple title from args only
    const payloadHash = hashExecutionPayload(executionPayload);
    const title = await generateSimulationTitle(
      executionPayload,
      this.decodingCache,
      opts.from,
      executionPayload.feePayer,
    );
    const interaction = WalletInteraction.from({
      id: payloadHash,
      type: "sendTx",
      title,
      description: `From: ${opts.from.toString()}`,
      complete: false,
      status: "SIMULATING",
      timestamp: Date.now(),
    });

    await this.interactionManager.storeAndEmit(interaction);

    return interaction;
  }

  async prepare(
    executionPayload: ExecutionPayload,
    opts: SendOptions<W>,
  ): Promise<
    PrepareResult<SendTxResult<W>, SendTxDisplayData, SendTxExecutionData<W>>
  > {
    const payloadHash = hashExecutionPayload(executionPayload);
    const fee = await this.completeFeeOptions(
      opts.from,
      executionPayload.feePayer,
      opts.fee?.gasSettings,
    );

    // Use simulateTx operation's prepare method (will throw if simulation fails)
    // Note: Strip the 'wait' property since SimulateOptions doesn't have it
    const { wait: _wait, ...simulateOpts } = opts;
    const prepared = await this.simulateTxOp.prepare(executionPayload, simulateOpts);

    // Decode simulation results
    const { callAuthorizations, executionTrace } =
      prepared.executionData!.decoded;

    // Create auth witnesses for call authorizations
    const authWitnesses = await Promise.all(
      callAuthorizations.map((auth) =>
        this.createAuthWit(opts.from, {
          caller: auth.rawData.caller,
          call: auth.rawData.functionCall,
        }),
      ),
    );
    executionPayload.authWitnesses.push(...authWitnesses);

    // Create transaction request
    const txRequest = await this.createTxExecutionRequestFromPayloadAndFee(
      executionPayload,
      opts.from,
      fee,
    );

    const title = await generateSimulationTitle(
      executionPayload,
      this.decodingCache,
      opts.from,
      executionPayload.feePayer,
    );

    return {
      displayData: {
        payloadHash,
        title,
        from: opts.from,
        callAuthorizations,
        executionTrace,
        stats: prepared.displayData?.stats,
        embeddedPaymentMethodFeePayer: executionPayload.feePayer,
      },
      executionData: {
        txRequest,
        wait: opts.wait,
      },
    };
  }

  async requestAuthorization(
    displayData: SendTxDisplayData,
    _persistence?: PersistenceConfig,
  ): Promise<void> {
    // Update interaction with detailed title and status
    await this.emitProgress("REQUESTING AUTHORIZATION", undefined, false, {
      title: displayData.title,
    });

    // Request authorization (never persisted for sendTx)
    await this.authorizationManager.requestAuthorization([
      {
        id: crypto.randomUUID(),
        appId: this.authorizationManager.appId,
        method: "sendTx",
        params: {
          callAuthorizations: displayData.callAuthorizations,
          executionTrace: displayData.executionTrace,
          title: displayData.title,
          from: displayData.from.toString(),
          stats: displayData.stats,
          embeddedPaymentMethodFeePayer:
            displayData.embeddedPaymentMethodFeePayer?.toString(),
        },
        timestamp: Date.now(),
      },
    ]);
  }

  async execute(executionData: SendTxExecutionData<W>): Promise<SendTxResult<W>> {
    // Report proving stage
    await this.emitProgress("PROVING");

    let provenTx;
    try {
      provenTx = await this.pxe.proveTx(executionData.txRequest);
    } catch (provingError: unknown) {
      // Proving failed - offer to export debug data
      const errorMessage =
        provingError instanceof Error
          ? provingError.message
          : String(provingError);

      await this.emitProgress("PROVING FAILED", errorMessage);

      // Generate profile data for debugging
      try {
        const profileResult = await this.pxe.profileTx(
          executionData.txRequest,
          "execution-steps",
          true, // skipProofGeneration - we just need the execution steps
        );

        // Serialize the execution steps to msgpack format
        const serializedData = serializePrivateExecutionSteps(
          profileResult.executionSteps,
        );

        // Emit event for UI to show the debug export dialog
        this.interactionManager.dispatchEvent(
          new CustomEvent("proof-debug-export-request", {
            detail: {
              id: crypto.randomUUID(),
              errorMessage,
              interactionTitle: this.interaction?.title ?? "Transaction",
              // Base64 encode the binary data for JSON transport
              debugData: Buffer.from(serializedData).toString("base64"),
            },
          }),
        );
      } catch (profileError) {
        // If profiling also fails, just log and continue with original error
        console.error(
          "Failed to generate profile for debug export:",
          profileError,
        );
      }

      // Re-throw the original proving error
      throw provingError;
    }

    const tx = await provenTx.toTx();
    const txHash = tx.getTxHash();

    if (await this.aztecNode.getTxEffect(txHash)) {
      throw new Error(
        `A settled tx with equal hash ${txHash.toString()} exists.`,
      );
    }

    // Report sending stage
    await this.emitProgress("SENDING", `TxHash: ${txHash.toString()}`);

    await this.aztecNode.sendTx(tx).catch((err) => {
      throw this.contextualizeError(err, inspect(tx));
    });

    // If wait is NO_WAIT, return txHash immediately
    if (executionData.wait === NO_WAIT) {
      await this.emitProgress("SENT", undefined, true);
      return txHash as SendTxResult<W>;
    }

    // Otherwise, wait for the full receipt (default behavior on wait: undefined)
    const waitOpts = typeof executionData.wait === 'object' ? executionData.wait : undefined;
    const receipt = await waitForTx(this.aztecNode, txHash, waitOpts);
    await this.emitProgress("SENT", undefined, true);
    return receipt as SendTxResult<W>;
  }
}
