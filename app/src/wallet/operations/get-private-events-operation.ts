import {
  ExternalOperation,
  type PrepareResult,
  type PersistenceConfig,
} from "./base-operation";
import type {
  PrivateEvent,
  PrivateEventFilter,
} from "@aztec/aztec.js/wallet";
import type { EventMetadataDefinition } from "@aztec/stdlib/abi";
import type { PXE } from "@aztec/pxe/server";
import {
  WalletInteraction,
  type WalletInteractionType,
} from "../types/wallet-interaction";
import type { InteractionManager } from "../managers/interaction-manager";
import type { AuthorizationManager } from "../managers/authorization-manager";
import type { DecodingCache } from "../decoding/decoding-cache";

// Arguments tuple for the operation
type GetPrivateEventsArgs = [
  eventMetadata: EventMetadataDefinition,
  eventFilter: PrivateEventFilter,
];

// Result type for the operation
type GetPrivateEventsResult<T> = PrivateEvent<T>[];

// Execution data stored between prepare and execute phases
interface GetPrivateEventsExecutionData<T> {
  eventMetadata: EventMetadataDefinition;
  eventFilter: PrivateEventFilter;
  events: PrivateEvent<T>[];
}

// Display data for authorization UI
type GetPrivateEventsDisplayData = {
  eventName: string;
  fromBlock?: number;
  toBlock?: number;
  eventCount: number;
  contractAddress?: string;
  contractName?: string;
};

/**
 * GetPrivateEvents operation implementation.
 *
 * PRIVACY SENSITIVE: This operation reveals private event data to the dApp.
 * Must require explicit user authorization.
 *
 * Handles private event access with the following features:
 * - Queries PXE for events matching the filter
 * - Decodes contract information
 * - Shows user what events will be revealed
 * - NOT persistent by default (can be made persistent for specific event types)
 */
export class GetPrivateEventsOperation<T = any> extends ExternalOperation<
  GetPrivateEventsArgs,
  GetPrivateEventsResult<T>,
  GetPrivateEventsExecutionData<T>,
  GetPrivateEventsDisplayData
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
    _eventMetadata: EventMetadataDefinition,
    _eventFilter: PrivateEventFilter,
  ): Promise<GetPrivateEventsResult<T> | undefined> {
    // No early return - always requires authorization
    return undefined;
  }

  async createInteraction(
    eventMetadata: EventMetadataDefinition,
    eventFilter: PrivateEventFilter,
  ): Promise<WalletInteraction<WalletInteractionType>> {
    const interaction = WalletInteraction.from({
      type: "getPrivateEvents",
      status: "PREPARING",
      complete: false,
      title: "Get Private Events",
      description: `Event: ${eventMetadata.eventSelector.name}`,
    });

    await this.interactionManager.storeAndEmit(interaction);

    return interaction;
  }

  async prepare(
    eventMetadata: EventMetadataDefinition,
    eventFilter: PrivateEventFilter,
  ): Promise<
    PrepareResult<
      GetPrivateEventsResult<T>,
      GetPrivateEventsDisplayData,
      GetPrivateEventsExecutionData<T>
    >
  > {
    // Query events to show count to user
    const events = await this.pxe.getPrivateEvents<T>(
      eventMetadata,
      eventFilter,
    );

    let contractName: string | undefined;
    if (eventFilter.contractAddress) {
      contractName = await this.decodingCache.getAddressAlias(
        eventFilter.contractAddress,
      );
    }

    const displayData: GetPrivateEventsDisplayData = {
      eventName: eventMetadata.eventSelector.name,
      fromBlock: eventFilter.fromBlock,
      toBlock: eventFilter.toBlock,
      eventCount: events.length,
      contractAddress: eventFilter.contractAddress?.toString(),
      contractName,
    };

    return {
      displayData,
      executionData: {
        eventMetadata,
        eventFilter,
        events,
      },
      // Can optionally be made persistent for specific event types
    };
  }

  async requestAuthorization(
    displayData: GetPrivateEventsDisplayData,
    persistence?: PersistenceConfig,
  ): Promise<void> {
    await this.emitProgress("REQUESTING AUTHORIZATION", undefined, false, {
      title: `Get Private Events: ${displayData.eventName}`,
    });

    await this.authorizationManager.requestAuthorization([
      {
        id: crypto.randomUUID(),
        appId: this.authorizationManager.appId,
        method: "getPrivateEvents",
        params: displayData,
        timestamp: Date.now(),
        persistence,
      },
    ]);
  }

  async execute(
    executionData: GetPrivateEventsExecutionData<T>,
  ): Promise<GetPrivateEventsResult<T>> {
    await this.emitProgress("SUCCESS", undefined, true);
    return executionData.events;
  }
}
