import { type Account, type ChainInfo } from "@aztec/aztec.js/account";
import {
  type Aliased,
  type SimulateOptions,
  type SendOptions,
  type BatchedMethod,
  type BatchableMethods,
  type BatchResults,
  type PrivateEvent,
  type PrivateEventFilter,
} from "@aztec/aztec.js/wallet";
import {
  type IntentInnerHash,
  type CallIntent,
} from "@aztec/aztec.js/authorization";
import type { EventMetadataDefinition } from "@aztec/stdlib/abi";

// Types not yet re-exported through public API
type ContractMetadata = {
  instance: ContractInstanceWithAddress;
  isContractInitialized: boolean;
  isContractPublished: boolean;
  isContractClassPubliclyRegistered: boolean;
  isContractUpdated: boolean;
  updatedContractClassId: Fr;
};

type ContractClassMetadata = {
  isArtifactRegistered: boolean;
  isContractClassPubliclyRegistered: boolean;
};
import { type AztecNode } from "@aztec/aztec.js/node";
import { type Logger } from "@aztec/aztec.js/log";
import type { AuthWitness } from "@aztec/stdlib/auth-witness";
import { FunctionCall, type ContractArtifact } from "@aztec/stdlib/abi";
import type { ContractInstanceWithAddress } from "@aztec/stdlib/contract";
import { Fr } from "@aztec/foundation/curves/bn254";
import { AztecAddress } from "@aztec/stdlib/aztec-address";
import {
  type TxSimulationResult,
  type UtilitySimulationResult,
  ExecutionPayload,
  TxHash,
} from "@aztec/stdlib/tx";
import { type PXE } from "@aztec/pxe/server";
import { WalletDB } from "../database/wallet-db";
import { type PromiseWithResolvers } from "@aztec/foundation/promise";
import {
  type AuthorizationRequest,
  type AuthorizationResponse,
  type AuthorizationItem,
  type GetAccountsAuthData,
  type GetAddressBookAuthData,
} from "../types/authorization";
import { BaseNativeWallet } from "./base-native-wallet";
import { ExternalOperation } from "../operations/base-operation";
import { RegisterContractOperation } from "../operations/register-contract-operation";
import { RegisterSenderOperation } from "../operations/register-sender-operation";
import { SimulateUtilityOperation } from "../operations/simulate-utility-operation";
import { SimulateTxOperation } from "../operations/simulate-tx-operation";
import { SendTxOperation } from "../operations/send-tx-operation";
import { GetAccountsOperation } from "../operations/get-accounts-operation";
import { GetAddressBookOperation } from "../operations/get-address-book-operation";
import { CreateAuthWitOperation } from "../operations/create-authwit-operation";
import { GetPrivateEventsOperation } from "../operations/get-private-events-operation";
import { GetContractMetadataOperation } from "../operations/get-contract-metadata-operation";
import { GetContractClassMetadataOperation } from "../operations/get-contract-class-metadata-operation";

export class ExternalWallet extends BaseNativeWallet {
  constructor(
    pxe: PXE,
    node: AztecNode,
    db: WalletDB,
    pendingAuthorizations: Map<
      string,
      {
        promise: PromiseWithResolvers<AuthorizationResponse>;
        request: AuthorizationRequest;
      }
    >,
    appId: string,
    chainInfo: ChainInfo,
    log: Logger,
  ) {
    super(pxe, node, db, pendingAuthorizations, appId, chainInfo, log);
  }

  /**
   * Factory method to create a fresh RegisterContractOperation instance.
   */
  private createRegisterContractOperation(): RegisterContractOperation {
    return new RegisterContractOperation(
      this.pxe,
      this.decodingCache,
      this.interactionManager,
      this.authorizationManager,
    );
  }

  /**
   * Factory method to create a fresh RegisterSenderOperation instance.
   */
  private createRegisterSenderOperation(): RegisterSenderOperation {
    return new RegisterSenderOperation(
      this.pxe,
      this.db,
      this.interactionManager,
      this.authorizationManager,
    );
  }

  /**
   * Factory method to create a fresh SimulateUtilityOperation instance.
   */
  private createSimulateUtilityOperation(): SimulateUtilityOperation {
    return new SimulateUtilityOperation(
      this.pxe,
      this.db,
      this.decodingCache,
      this.interactionManager,
      this.authorizationManager,
    );
  }

  /**
   * Factory method to create a fresh SimulateTxOperation instance.
   */
  private createSimulateTxOperation(): SimulateTxOperation {
    return new SimulateTxOperation(
      this.pxe,
      this.db,
      this.decodingCache,
      this.interactionManager,
      this.authorizationManager,
      this.completeFeeOptionsForEstimation.bind(this),
      this.completeFeeOptions.bind(this),
      this.getFakeAccountDataFor.bind(this),
      this.getChainInfo.bind(this),
      this.cancellableTransactions,
    );
  }

  /**
   * Factory method to create a fresh SendTxOperation instance.
   * @param simulateTxOp - The SimulateTxOperation instance to use (may be fresh or shared)
   */
  private createSendTxOperation(
    simulateTxOp: SimulateTxOperation,
  ): SendTxOperation {
    return new SendTxOperation(
      this.pxe,
      this.aztecNode,
      this.decodingCache,
      this.interactionManager,
      this.authorizationManager,
      simulateTxOp,
      this.createAuthWitForSendTx.bind(this),
      this.createTxExecutionRequestFromPayloadAndFee.bind(this),
      this.completeFeeOptions.bind(this),
      this.contextualizeError.bind(this),
    );
  }

  /**
   * Factory method to create a fresh GetAccountsOperation instance.
   */
  private createGetAccountsOperation(): GetAccountsOperation {
    return new GetAccountsOperation(
      this.db,
      this.interactionManager,
      this.authorizationManager,
    );
  }

  /**
   * Factory method to create a fresh GetAddressBookOperation instance.
   */
  private createGetAddressBookOperation(): GetAddressBookOperation {
    return new GetAddressBookOperation(
      this.db,
      this.interactionManager,
      this.authorizationManager,
    );
  }

  /**
   * Internal helper to create authwit without authorization.
   * Used by CreateAuthWitOperation after user has approved.
   */
  private async createAuthWitInternal(
    from: AztecAddress,
    messageHashOrIntent: IntentInnerHash | CallIntent,
    chainInfo: ChainInfo,
  ): Promise<AuthWitness> {
    const account = await this.getAccountFromAddress(from);
    return account.createAuthWit(messageHashOrIntent, chainInfo);
  }

  /**
   * Internal helper for SendTxOperation to create auth witnesses without external authorization.
   * This is used when sendTx internally needs to create auth witnesses for call authorizations.
   * These are implicit authorizations that don't require user approval since the user already
   * approved the transaction itself.
   */
  private async createAuthWitForSendTx(
    from: AztecAddress,
    auth: CallIntent,
  ): Promise<AuthWitness> {
    const account = await this.getAccountFromAddress(from);
    return account.createAuthWit(auth, this.chainInfo);
  }

  /**
   * Factory method to create a fresh CreateAuthWitOperation instance.
   */
  private createCreateAuthWitOperation(): CreateAuthWitOperation {
    return new CreateAuthWitOperation(
      this.decodingCache,
      this.interactionManager,
      this.authorizationManager,
      this.createAuthWitInternal.bind(this),
      this.chainInfo,
    );
  }

  /**
   * Factory method to create a fresh GetPrivateEventsOperation instance.
   */
  private createGetPrivateEventsOperation<T>(): GetPrivateEventsOperation<T> {
    return new GetPrivateEventsOperation<T>(
      this.pxe,
      this.decodingCache,
      this.interactionManager,
      this.authorizationManager,
    );
  }

  /**
   * Factory method to create a fresh GetContractMetadataOperation instance.
   */
  private createGetContractMetadataOperation(): GetContractMetadataOperation {
    return new GetContractMetadataOperation(
      this.pxe,
      this.decodingCache,
      this.interactionManager,
      this.authorizationManager,
    );
  }

  /**
   * Factory method to create a fresh GetContractClassMetadataOperation instance.
   */
  private createGetContractClassMetadataOperation(): GetContractClassMetadataOperation {
    return new GetContractClassMetadataOperation(
      this.pxe,
      this.interactionManager,
      this.authorizationManager,
    );
  }

  /**
   * Retrieves an account by address, with authorization check.
   *
   * This method ensures the app has permission to access the requested account
   * by checking the persistent getAccounts authorization. Only accounts that
   * the user explicitly authorized can be accessed.
   *
   * @param address - The account address to retrieve
   * @returns Account instance for the given address
   * @throws Error if app doesn't have authorization for this account
   */
  protected async getAccountFromAddress(
    address: AztecAddress,
  ): Promise<Account> {
    if (!address.equals(AztecAddress.ZERO)) {
      // Check if there's a persistent getAccounts authorization
      const authData = await this.db.retrievePersistentAuthorization(
        this.appId,
        "getAccounts",
      );

      if (!authData || !authData.accounts) {
        throw new Error(
          `App ${this.appId} does not have authorization to access any accounts. Please request getAccounts authorization first.`,
        );
      }

      // Check if the specific account is in the authorized list
      const authorizedAddresses = authData.accounts.map((acc: any) =>
        acc.item.toString(),
      );
      const requestedAddress = address.toString();

      if (!authorizedAddresses.includes(requestedAddress)) {
        throw new Error(
          `App ${this.appId} does not have authorization to use account ${requestedAddress}. Authorized accounts: ${authorizedAddresses.join(", ")}`,
        );
      }
    }

    // Authorization passed, delegate to base implementation
    return this.getAccountFromAddressInternal(address);
  }

  // External API methods - all require authorization

  override async getAccounts(): Promise<Aliased<AztecAddress>[]> {
    const op = this.createGetAccountsOperation();
    return await op.executeStandalone();
  }

  /**
   * Register a contract with the wallet.
   * Uses the RegisterContractOperation for clean separation of concerns.
   */
  override async registerContract(
    instance: ContractInstanceWithAddress,
    artifact?: ContractArtifact,
    secretKey?: Fr,
  ): Promise<ContractInstanceWithAddress> {
    const op = this.createRegisterContractOperation();
    return await op.executeStandalone(instance, artifact, secretKey);
  }

  override async registerSender(
    address: AztecAddress,
    alias: string,
  ): Promise<AztecAddress> {
    const op = this.createRegisterSenderOperation();
    return await op.executeStandalone(address, alias);
  }

  override async getAddressBook(): Promise<Aliased<AztecAddress>[]> {
    const op = this.createGetAddressBookOperation();
    return await op.executeStandalone();
  }

  override async createAuthWit(
    from: AztecAddress,
    messageHashOrIntent: IntentInnerHash | CallIntent,
  ): Promise<AuthWitness> {
    const op = this.createCreateAuthWitOperation();
    return await op.executeStandalone(from, messageHashOrIntent);
  }

  override async getPrivateEvents<T>(
    eventMetadata: EventMetadataDefinition,
    eventFilter: PrivateEventFilter,
  ): Promise<PrivateEvent<T>[]> {
    const op = this.createGetPrivateEventsOperation<T>();
    return await op.executeStandalone(eventMetadata, eventFilter);
  }

  override async getContractMetadata(
    address: AztecAddress,
  ): Promise<ContractMetadata> {
    const op = this.createGetContractMetadataOperation();
    return await op.executeStandalone(address);
  }

  override async getContractClassMetadata(
    id: Fr,
  ): Promise<ContractClassMetadata> {
    const op = this.createGetContractClassMetadataOperation();
    return await op.executeStandalone(id);
  }

  override async sendTx(
    exec: ExecutionPayload,
    opts: SendOptions,
  ): Promise<TxHash> {
    const simulateTxOp = this.createSimulateTxOperation();
    const op = this.createSendTxOperation(simulateTxOp);
    return await op.executeStandalone(exec, opts);
  }

  override async batch<const T extends readonly BatchedMethod[]>(
    methods: T,
  ): Promise<BatchResults<T>> {
    type BatchMethodResult =
      | ContractInstanceWithAddress
      | TxHash
      | AztecAddress
      | UtilitySimulationResult
      | TxSimulationResult;

    interface BatchItem {
      operation: ExternalOperation<any, any, any>;
      originalName: string;
      args: any[];
      earlyReturn?: any;
      error?: any;
      displayData?: Record<string, unknown>;
      executionData?: any;
      persistence?: { storageKey: string; persistData: any };
    }

    const items: BatchItem[] = [];

    // ========================================================================
    // PHASE 0: CHECK & CREATE OPERATIONS - One instance per batch item
    // ========================================================================
    for (const methodCall of methods) {
      const { name, args } = methodCall;

      // Create a fresh operation instance for this specific batch item
      let operation: ExternalOperation<any, any, any>;

      switch (name) {
        case "registerContract":
          operation = this.createRegisterContractOperation();
          break;
        case "registerSender":
          operation = this.createRegisterSenderOperation();
          break;
        case "simulateUtility":
          operation = this.createSimulateUtilityOperation();
          break;
        case "simulateTx":
          operation = this.createSimulateTxOperation();
          break;
        case "sendTx":
          // Only create simulateTxOp when needed for sendTx operations
          const simulateTxOp = this.createSimulateTxOperation();
          operation = this.createSendTxOperation(simulateTxOp);
          break;
        case "getAccounts":
          operation = this.createGetAccountsOperation();
          break;
        case "getAddressBook":
          operation = this.createGetAddressBookOperation();
          break;
        case "createAuthWit":
          operation = this.createCreateAuthWitOperation();
          break;
        case "getPrivateEvents":
          operation = this.createGetPrivateEventsOperation();
          break;
        case "getContractMetadata":
          operation = this.createGetContractMetadataOperation();
          break;
        case "getContractClassMetadata":
          operation = this.createGetContractClassMetadataOperation();
          break;
        default:
          items.push({
            operation: null as any,
            originalName: name,
            args,
            error: new Error(`Method ${name} is not supported in batch`),
          });
          continue;
      }

      try {
        // Run check phase
        const earlyResult = await (operation as any).check(...args);

        if (earlyResult !== undefined) {
          // Early return - no interaction needed
          items.push({
            operation,
            originalName: name,
            args,
            earlyReturn: earlyResult,
          });
        } else {
          // Normal flow - will create interaction and proceed
          items.push({
            operation,
            originalName: name,
            args,
          });
        }
      } catch (error) {
        items.push({
          operation,
          originalName: name,
          args,
          error,
        });
      }
    }

    // ========================================================================
    // PHASE 1: CREATE INTERACTIONS - For items without early return
    // ========================================================================
    for (const item of items) {
      if (item.earlyReturn !== undefined || item.error) {
        continue;
      }

      try {
        const interaction = await (item.operation as any).createInteraction(
          ...item.args,
        );
        item.operation.setCurrentInteraction(interaction);
      } catch (error) {
        item.error = error;
      }
    }

    // ========================================================================
    // PHASE 2: PREPARE - Call prepare() on all operations
    // ========================================================================
    for (const item of items) {
      if (item.earlyReturn !== undefined || item.error) {
        continue;
      }

      try {
        const result = await (item.operation as any).prepare(...item.args);

        item.displayData = result.displayData;
        item.executionData = result.executionData;
        item.persistence = result.persistence;
      } catch (error) {
        const description =
          error instanceof Error ? error.message : String(error);
        await item.operation.emitProgress("ERROR", description, true);
        item.error = error;
      }
    }

    // ========================================================================
    // PHASE 3: REQUEST AUTHORIZATION - Batch all items together
    // ========================================================================
    const authItems: AuthorizationItem[] = [];
    const authItemMap = new Map<string, number>(); // itemId -> items index

    for (let i = 0; i < items.length; i++) {
      const item = items[i];

      if (item.earlyReturn !== undefined || item.error) {
        continue;
      }

      const itemId = Fr.random().toString();

      // Flatten displayData for simulateTx to match standalone flow format
      let params = item.displayData!;
      if (item.originalName === "simulateTx" && (params as any).decoded) {
        params = {
          ...params,
          callAuthorizations: (params as any).decoded.callAuthorizations,
          executionTrace: (params as any).decoded.executionTrace,
        };
        delete (params as any).decoded; // Remove nested structure
      }

      authItems.push({
        id: itemId,
        appId: this.appId,
        method: item.originalName,
        params,
        timestamp: Date.now(),
        persistence: item.persistence,
      });

      authItemMap.set(itemId, i);
    }

    let response: AuthorizationResponse | null = null;

    if (authItems.length > 0) {
      // Update all interactions to "REQUESTING AUTHORIZATION"
      for (const item of items) {
        if (item.earlyReturn === undefined && !item.error) {
          await item.operation.emitProgress("REQUESTING AUTHORIZATION");
        }
      }

      try {
        response =
          await this.authorizationManager.requestAuthorization(authItems);
      } catch (error) {
        // Authorization was denied - mark all pending items as ERROR
        for (const item of items) {
          if (item.earlyReturn === undefined && !item.error) {
            await item.operation.emitProgress(
              "ERROR",
              "Authorization denied",
              true,
            );
          }
        }
        throw error;
      }
    }

    // ========================================================================
    // PHASE 4: EXECUTE - Run execute() on all authorized operations
    // ========================================================================
    const results: { name: string; result: BatchMethodResult }[] = [];

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      let result: BatchMethodResult;

      if (item.earlyReturn !== undefined) {
        // Early return - just use the cached result
        result = item.earlyReturn;
      } else if (item.error) {
        // Error occurred in earlier phase
        throw item.error;
      } else {
        // Check authorization
        let itemId: string | undefined;
        for (const [id, index] of authItemMap.entries()) {
          if (index === i) {
            itemId = id;
            break;
          }
        }

        if (itemId && response) {
          const itemResponse = response.itemResponses[itemId];
          if (!itemResponse || !itemResponse.approved) {
            await item.operation.emitProgress(
              "ERROR",
              "Authorization denied",
              true,
            );
            throw new Error(`Authorization denied for ${item.originalName}`);
          }
        }

        // Execute the operation
        try {
          result = await item.operation.execute(item.executionData!);
        } catch (error) {
          const description =
            error instanceof Error ? error.message : String(error);
          await item.operation.emitProgress("ERROR", description, true);
          throw error;
        }
      }

      results.push({
        name: item.originalName,
        result,
      });
    }

    return results as BatchResults<T>;
  }

  override async simulateTx(
    executionPayload: ExecutionPayload,
    opts: SimulateOptions,
  ): Promise<TxSimulationResult> {
    const op = this.createSimulateTxOperation();
    return await op.executeStandalone(executionPayload, opts);
  }

  /**
   * Public method: Simulate utility function (standalone call).
   * Handles interaction tracking and user authorization.
   */
  override async simulateUtility(
    call: FunctionCall,
    authwits?: AuthWitness[],
    scopes?: AztecAddress[],
  ): Promise<UtilitySimulationResult> {
    const op = this.createSimulateUtilityOperation();
    return await op.executeStandalone(call, authwits, scopes);
  }
}
