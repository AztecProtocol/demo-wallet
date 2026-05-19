import { ExternalOperation, type PrepareResult, type PersistenceConfig } from "./base-operation";
import { AztecAddress } from "@aztec/stdlib/aztec-address";
import { type ExecutionPayload, BlockHeader } from "@aztec/stdlib/tx";
import type { PXE } from "@aztec/pxe/client/lazy";
import { NO_FROM } from "@aztec/aztec.js/account";
import { WalletInteraction, type WalletInteractionType } from "../types/wallet-interaction";
import type { WalletDB, StoredStats } from "../database/wallet-db";
import type { InteractionManager } from "../managers/interaction-manager";
import type { AuthorizationManager } from "../managers/authorization-manager";
import type { DecodingCache } from "../decoding/decoding-cache";
import { TxDecodingService } from "../decoding/tx-decoding-service";
import type { ReadableCallAuthorization } from "../decoding/call-authorization-formatter";
import type { DecodedExecutionTrace } from "../decoding/tx-callstack-decoder";
import { hashExecutionPayload, generateSimulationTitle } from "../utils/simulation-utils";
import { TxSimulationResultWithAppOffset, type SimulateOptions } from "@aztec/aztec.js/wallet";
import type { Logger } from "@aztec/aztec.js/log";
import {
  type FeeOptions,
  type CompleteFeeOptionsConfig,
  type SimulateViaEntrypointOptions,
  extractOptimizablePublicStaticCalls,
  simulateViaNode,
  buildMergedSimulationResult,
} from "@aztec/wallet-sdk/base-wallet";
import type { AztecNode } from "@aztec/aztec.js/node";
import type { ChainInfo } from "@aztec/entrypoints/interfaces";

// Readable transaction information with decoded data
interface ReadableTxInformation {
  callAuthorizations: ReadableCallAuthorization[];
  executionTrace: DecodedExecutionTrace;
}

// Arguments tuple for the operation
type SimulateTxArgs = [
  executionPayload: ExecutionPayload,
  opts: SimulateOptions,
  existingInteraction?: WalletInteraction<WalletInteractionType>,
];

// Result type for the operation
type SimulateTxResult = TxSimulationResultWithAppOffset;

// Execution data stored between prepare and execute phases
interface SimulateTxExecutionData {
  simulationResult: TxSimulationResultWithAppOffset;
  payloadHash: string;
  decoded?: ReadableTxInformation;
}

// Display data for authorization UI
type SimulateTxDisplayData = {
  payloadHash: string;
  title: string;
  from: AztecAddress | typeof NO_FROM;
  decoded: ReadableTxInformation;
  stats?: StoredStats;
  embeddedPaymentMethodFeePayer?: string;
};

/**
 * SimulateTx operation implementation.
 *
 * Delegates simulation to the wallet's own simulateViaEntrypoint (injected as a
 * callback), keeping the operation free of account/entrypoint plumbing.
 * Public static calls are optimised via the node path before the private path runs.
 */
export class SimulateTxOperation extends ExternalOperation<
  SimulateTxArgs,
  SimulateTxResult,
  SimulateTxExecutionData,
  SimulateTxDisplayData
> {
  protected interactionManager: InteractionManager;

  constructor(
    private pxe: PXE,
    private node: AztecNode,
    private db: WalletDB,
    private decodingCache: DecodingCache,
    interactionManager: InteractionManager,
    private authorizationManager: AuthorizationManager,
    private completeFeeOptions: (config: CompleteFeeOptionsConfig) => Promise<FeeOptions>,
    private simulateViaEntrypoint: (
      payload: ExecutionPayload,
      opts: SimulateViaEntrypointOptions,
    ) => Promise<TxSimulationResultWithAppOffset>,
    private getChainInfo: () => Promise<ChainInfo>,
    private log: Logger,
  ) {
    super();
    this.interactionManager = interactionManager;
  }

  async check(
    _executionPayload: ExecutionPayload,
    _opts: SimulateOptions,
  ): Promise<SimulateTxResult | undefined> {
    return undefined;
  }

  async prepare(
    executionPayload: ExecutionPayload,
    opts: SimulateOptions,
  ): Promise<PrepareResult<SimulateTxDisplayData, SimulateTxExecutionData>> {
    const payloadHash = hashExecutionPayload(executionPayload);
    const title = await generateSimulationTitle(
      executionPayload,
      this.decodingCache,
      opts.from,
      executionPayload.feePayer,
    );

    const feeOptions = await this.completeFeeOptions({
      from: opts.from,
      feePayer: executionPayload.feePayer,
      gasSettings: opts.fee?.gasSettings,
      forEstimation: true,
    });

    // Split calls into the public-static fast path and the normal private path
    const { optimizableCalls, remainingCalls } =
      extractOptimizablePublicStaticCalls(executionPayload);

    let blockHeader: BlockHeader;
    try {
      blockHeader = await this.pxe.getSyncedBlockHeader();
    } catch {
      blockHeader = (await this.node.getBlockHeader())!;
    }

    const simulationOrigin = opts.from === NO_FROM ? AztecAddress.ZERO : opts.from;
    const chainInfo = await this.getChainInfo();
    const simulationStart = Date.now();

    const [optimizedResults, normalResult] = await Promise.all([
      optimizableCalls.length > 0
        ? simulateViaNode(
            this.node,
            optimizableCalls,
            simulationOrigin,
            chainInfo,
            feeOptions.gasSettings,
            blockHeader,
            opts.skipFeeEnforcement ?? true,
            (address: AztecAddress) => this.decodingCache.getAddressAlias(address),
          )
        : Promise.resolve([]),
      remainingCalls.length > 0
        ? this.simulateViaEntrypoint(
            { ...executionPayload, calls: remainingCalls },
            {
              from: opts.from,
              feeOptions,
              additionalScopes: opts.additionalScopes,
              skipTxValidation: opts.skipTxValidation,
              skipFeeEnforcement: opts.skipFeeEnforcement ?? true,
              sendMessagesAs: opts.sendMessagesAs,
            },
          )
        : Promise.resolve(null),
    ]);

    const wallTime = Date.now() - simulationStart;
    const simulationResult = buildMergedSimulationResult(optimizedResults, normalResult);
    const metadataStats: StoredStats = simulationResult.stats
      ? (simulationResult.stats as StoredStats)
      : {
          timings: {
            sync: 0,
            perFunction: [],
            unaccounted: 0,
            total: wallTime,
            simulation: wallTime,
          },
        };

    await this.db.storeTxPayloadData(payloadHash, simulationResult, {
      from: opts.from.toString(),
      embeddedPaymentMethodFeePayer: executionPayload.feePayer?.toString(),
      stats: metadataStats,
    });

    const decodingService = new TxDecodingService(this.decodingCache, this.log);
    const decoded = await decodingService.decodeTransaction(simulationResult);

    const storageKeys =
      executionPayload.calls?.map((call) => `simulateTx:${call.to.toString()}:${call.name}`) || [];

    return {
      displayData: {
        payloadHash,
        title,
        from: opts.from,
        decoded,
        stats: metadataStats,
        embeddedPaymentMethodFeePayer: executionPayload.feePayer?.toString(),
      },
      executionData: {
        simulationResult,
        payloadHash,
        decoded,
      },
      persistence: {
        storageKey: storageKeys,
        persistData: null,
      },
    };
  }

  async createInteraction(
    executionPayload: ExecutionPayload,
    opts: SimulateOptions,
  ): Promise<WalletInteraction<WalletInteractionType>> {
    const payloadHash = hashExecutionPayload(executionPayload);
    const title = await generateSimulationTitle(
      executionPayload,
      this.decodingCache,
      opts.from,
      executionPayload.feePayer,
    );
    const interaction = WalletInteraction.from({
      id: payloadHash,
      type: "simulateTx",
      title,
      description: `From: ${opts.from.toString()}`,
      complete: false,
      status: "SIMULATING",
      timestamp: Date.now(),
    });

    await this.interactionManager.storeAndEmit(interaction);
    return interaction;
  }

  async requestAuthorization(
    displayData: SimulateTxDisplayData,
    persistence?: PersistenceConfig,
  ): Promise<void> {
    await this.emitProgress("REQUESTING AUTHORIZATION", undefined, false, {
      title: displayData.title,
    });

    await this.authorizationManager.requestAuthorization([
      {
        id: crypto.randomUUID(),
        appId: this.authorizationManager.appId,
        method: "simulateTx",
        params: {
          payloadHash: displayData.payloadHash,
          callAuthorizations: displayData.decoded.callAuthorizations,
          executionTrace: displayData.decoded.executionTrace,
          title: displayData.title,
          from: displayData.from.toString(),
          stats: displayData.stats,
          embeddedPaymentMethodFeePayer: displayData.embeddedPaymentMethodFeePayer,
        },
        timestamp: Date.now(),
        persistence,
      },
    ]);
  }

  async execute(executionData: SimulateTxExecutionData): Promise<SimulateTxResult> {
    await this.emitProgress("SUCCESS", undefined, true);
    return executionData.simulationResult;
  }
}
