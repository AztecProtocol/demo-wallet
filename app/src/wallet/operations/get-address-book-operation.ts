import {
  ExternalOperation,
  type PrepareResult,
  type PersistenceConfig,
} from "./base-operation";
import type { Aliased } from "@aztec/aztec.js/wallet";
import { AztecAddress } from "@aztec/stdlib/aztec-address";
import {
  WalletInteraction,
  type WalletInteractionType,
} from "../types/wallet-interaction";
import type { WalletDB } from "../database/wallet-db";
import type { InteractionManager } from "../managers/interaction-manager";
import type { AuthorizationManager } from "../managers/authorization-manager";

// Arguments tuple for the operation (no args for getAddressBook)
type GetAddressBookArgs = [];

// Result type for the operation
type GetAddressBookResult = Aliased<AztecAddress>[];

// Execution data stored between prepare and execute phases
interface GetAddressBookExecutionData {
  contacts: Aliased<AztecAddress>[];
}

// Display data for authorization UI
type GetAddressBookDisplayData = {
  contacts: Aliased<AztecAddress>[];
};

/**
 * GetAddressBook operation implementation.
 *
 * Handles address book access authorization with the following features:
 * - Lists all senders (contacts) from database
 * - User selects which contacts to share with the app
 * - User can customize aliases visible to the app
 * - Persistent authorization (app can access selected contacts without re-prompting)
 */
export class GetAddressBookOperation extends ExternalOperation<
  GetAddressBookArgs,
  GetAddressBookResult,
  GetAddressBookExecutionData,
  GetAddressBookDisplayData
> {
  protected interactionManager: InteractionManager;
  private selectedContacts?: Array<{ alias: string; item: string }>;

  constructor(
    private db: WalletDB,
    interactionManager: InteractionManager,
    private authorizationManager: AuthorizationManager,
  ) {
    super();
    this.interactionManager = interactionManager;
  }

  async check(): Promise<GetAddressBookResult | undefined> {
    // No early return checks for this operation
    return undefined;
  }

  async createInteraction(): Promise<WalletInteraction<WalletInteractionType>> {
    const interaction = WalletInteraction.from({
      type: "getAddressBook",
      status: "PREPARING",
      complete: false,
      title: "Get Address Book",
      description: "App requesting access to contacts",
    });

    await this.interactionManager.storeAndEmit(interaction);

    return interaction;
  }

  async prepare(): Promise<
    PrepareResult<
      GetAddressBookResult,
      GetAddressBookDisplayData,
      GetAddressBookExecutionData
    >
  > {
    // Load all senders from database
    const senders = await this.db.listSenders();
    const contacts: Aliased<AztecAddress>[] = senders.map((sender) => ({
      alias: sender.alias.replace("senders:", ""),
      item: sender.item,
    }));

    return {
      displayData: { contacts },
      executionData: { contacts },
      persistence: {
        storageKey: "getAddressBook",
        persistData: null, // Will be filled from authorization response
      },
    };
  }

  async requestAuthorization(
    _displayData: GetAddressBookDisplayData,
    persistence?: PersistenceConfig,
  ): Promise<void> {
    await this.emitProgress("REQUESTING AUTHORIZATION", undefined, false, {
      title: "Get Address Book",
    });

    const itemId = crypto.randomUUID();
    const response = await this.authorizationManager.requestAuthorization([
      {
        id: itemId,
        appId: this.authorizationManager.appId,
        method: "getAddressBook",
        params: {},
        timestamp: Date.now(),
        persistence,
      },
    ]);

    // Extract selected contacts from authorization response
    const itemResponse = response.itemResponses[itemId];
    const authData = itemResponse?.data as any;

    if (!authData || !authData.contacts) {
      throw new Error("Authorization response missing contact data");
    }

    // Store the contacts selected by the user
    this.selectedContacts = authData.contacts.map((contact: any) => ({
      alias: contact.alias,
      item: typeof contact.item === "string" ? contact.item : contact.item.toString(),
    }));
  }

  async execute(
    _executionData: GetAddressBookExecutionData,
  ): Promise<GetAddressBookResult> {
    await this.emitProgress("SUCCESS", undefined, true);

    // Return the contacts selected by the user during authorization
    if (!this.selectedContacts) {
      throw new Error("No contacts were selected during authorization");
    }

    return this.selectedContacts.map((contact) => ({
      alias: contact.alias,
      item: AztecAddress.fromString(contact.item),
    }));
  }
}
