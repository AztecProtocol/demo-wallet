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

// Arguments tuple for the operation (no args for getAccounts)
type GetAccountsArgs = [];

// Result type for the operation
type GetAccountsResult = Aliased<AztecAddress>[];

// Execution data stored between prepare and execute phases
interface GetAccountsExecutionData {
  accounts: Aliased<AztecAddress>[];
}

// Display data for authorization UI
type GetAccountsDisplayData = {
  accounts: Aliased<AztecAddress>[];
};

/**
 * GetAccounts operation implementation.
 *
 * Handles account access authorization with the following features:
 * - Lists all available accounts from database
 * - User selects which accounts to share with the app
 * - User can customize aliases visible to the app
 * - Persistent authorization (app can access selected accounts without re-prompting)
 */
export class GetAccountsOperation extends ExternalOperation<
  GetAccountsArgs,
  GetAccountsResult,
  GetAccountsExecutionData,
  GetAccountsDisplayData
> {
  protected interactionManager: InteractionManager;
  private selectedAccounts?: Array<{ alias: string; item: string }>;

  constructor(
    private db: WalletDB,
    interactionManager: InteractionManager,
    private authorizationManager: AuthorizationManager,
  ) {
    super();
    this.interactionManager = interactionManager;
  }

  async check(): Promise<GetAccountsResult | undefined> {
    // No early return checks for this operation
    return undefined;
  }

  async createInteraction(): Promise<WalletInteraction<WalletInteractionType>> {
    const interaction = WalletInteraction.from({
      type: "getAccounts",
      status: "PREPARING",
      complete: false,
      title: "Get Accounts",
      description: "App requesting access to accounts",
    });

    await this.interactionManager.storeAndEmit(interaction);

    return interaction;
  }

  async prepare(): Promise<
    PrepareResult<
      GetAccountsResult,
      GetAccountsDisplayData,
      GetAccountsExecutionData
    >
  > {
    // Load all accounts from database
    const accounts = await this.db.listAccounts();
    const aliasedAccounts: Aliased<AztecAddress>[] = accounts.map((acc) => ({
      alias: acc.alias,
      item: acc.item,
    }));

    return {
      displayData: { accounts: aliasedAccounts },
      executionData: { accounts: aliasedAccounts },
      persistence: {
        storageKey: "getAccounts",
        persistData: null, // Will be filled from authorization response
      },
    };
  }

  async requestAuthorization(
    _displayData: GetAccountsDisplayData,
    persistence?: PersistenceConfig,
  ): Promise<void> {
    await this.emitProgress("REQUESTING AUTHORIZATION", undefined, false, {
      title: "Get Accounts",
    });

    const itemId = crypto.randomUUID();
    const response = await this.authorizationManager.requestAuthorization([
      {
        id: itemId,
        appId: this.authorizationManager.appId,
        method: "getAccounts",
        params: {},
        timestamp: Date.now(),
        persistence,
      },
    ]);

    // Extract selected accounts from authorization response
    const itemResponse = response.itemResponses[itemId];
    const authData = itemResponse?.data as any;

    if (!authData || !authData.accounts) {
      throw new Error("Authorization response missing account data");
    }

    // Store the accounts selected by the user
    this.selectedAccounts = authData.accounts.map((acc: any) => ({
      alias: acc.alias,
      item: typeof acc.item === "string" ? acc.item : acc.item.toString(),
    }));
  }

  async execute(
    _executionData: GetAccountsExecutionData,
  ): Promise<GetAccountsResult> {
    await this.emitProgress("SUCCESS", undefined, true);

    // Return the accounts selected by the user during authorization
    if (!this.selectedAccounts) {
      throw new Error("No accounts were selected during authorization");
    }

    return this.selectedAccounts.map((acc) => ({
      alias: acc.alias,
      item: AztecAddress.fromString(acc.item),
    }));
  }
}
