import {
  type Account,
  type ChainInfo,
  type NoFrom,
  NO_FROM,
} from "@aztec/aztec.js/account";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { AccountManager, type Aliased } from "@aztec/aztec.js/wallet";
import { Fq, Fr } from "@aztec/aztec.js/fields";
import { getContractInstanceFromInstantiationParams } from "@aztec/aztec.js/contracts";
import { type AztecNode } from "@aztec/aztec.js/node";
import { type Logger } from "@aztec/aztec.js/log";
import { DecodingCache } from "../decoding/decoding-cache";
import { InteractionManager } from "../managers/interaction-manager";
import { AuthorizationManager } from "../managers/authorization-manager";
import type { PXE } from "@aztec/pxe/client/lazy";
import type { AccountType, WalletDB } from "../database/wallet-db";
import type { PromiseWithResolvers } from "@aztec/foundation/promise";
import type {
  AuthorizationRequest,
  AuthorizationResponse,
} from "../types/authorization";
import {
  EcdsaKAccountContract,
  EcdsaRAccountContract,
} from "@aztec/accounts/ecdsa";
import { SchnorrAccountContract } from "@aztec/accounts/schnorr";
import {
  createStubAccount,
  StubAccountContractArtifact,
} from "@aztec/accounts/stub";
import type { ContractInstanceWithAddress } from "@aztec/stdlib/contract";
import type { ContractArtifact } from "@aztec/stdlib/abi";
import { BaseWallet } from "@aztec/wallet-sdk/base-wallet";

/**
 * Base class for native wallet implementations (external and internal).
 * Provides common functionality for both trusted and untrusted wallet contexts.
 *
 * This class handles:
 * - Event emission (EventTarget implementation for wallet updates)
 * - Interaction tracking and storage
 * - Account management and creation
 * - Fee calculation and payment method setup
 * - Contract name resolution via shared decoding cache
 *
 * Subclasses must implement authorization logic appropriate to their trust level:
 * - ExternalWallet: Requires user authorization for all operations
 * - InternalWallet: Auto-approves all operations (trusted GUI)
 */
export abstract class BaseNativeWallet
  extends BaseWallet
  implements EventTarget
{
  protected decodingCache: DecodingCache;
  protected interactionManager: InteractionManager;
  protected authorizationManager: AuthorizationManager;

  constructor(
    pxe: PXE,
    node: AztecNode,
    protected db: WalletDB,
    protected pendingAuthorizations: Map<
      string,
      {
        promise: PromiseWithResolvers<AuthorizationResponse>;
        request: AuthorizationRequest;
      }
    >,
    protected appId: string,
    protected chainInfo: ChainInfo,
    protected override log: Logger,
  ) {
    super(pxe, node);
    // Create a single decoding cache instance shared across all wallet operations
    // This cache stores contract names, artifacts, and aliases to avoid repeated PXE lookups
    this.decodingCache = new DecodingCache(pxe, db);

    // Create manager instances for operations to use
    this.interactionManager = new InteractionManager(db);
    this.authorizationManager = new AuthorizationManager(
      appId,
      db,
      pendingAuthorizations,
      this.interactionManager, // Use interactionManager as the event emitter
    );
  }

  /**
   * Creates an AccountManager for a given account type and signing key.
   *
   * This method:
   * 1. Instantiates the appropriate account contract (Schnorr, ECDSA K-256, ECDSA R-1)
   * 2. Creates an AccountManager with the contract
   * 3. Registers the account contract with PXE for simulation/execution
   *
   * @param type - Account type (schnorr, ecdsasecp256k1, ecdsasecp256r1)
   * @param secret - Account secret key
   * @param salt - Deployment salt
   * @param signingKey - Signing key for the account
   * @returns AccountManager for this account
   */
  async getAccountManager(
    type: AccountType,
    secret: Fr,
    salt: Fr,
    signingKey: Buffer,
  ): Promise<AccountManager> {
    let contract;
    switch (type) {
      case "schnorr": {
        contract = new SchnorrAccountContract(Fq.fromBuffer(signingKey));
        break;
      }
      case "ecdsasecp256k1": {
        contract = new EcdsaKAccountContract(signingKey);
        break;
      }
      case "ecdsasecp256r1": {
        contract = new EcdsaRAccountContract(signingKey);
        break;
      }
      default: {
        throw new Error(`Unknown account type ${type}`);
      }
    }

    const accountManager = await AccountManager.create(
      this,
      secret,
      contract,
      salt,
    );

    const instance = accountManager.getInstance();
    const existingInstance = await this.pxe.getContractInstance(
      instance.address,
    );
    if (!existingInstance) {
      const existingArtifact = await this.pxe.getContractArtifact(
        instance.currentContractClassId,
      );
      await this.registerContract(
        instance,
        !existingArtifact
          ? await accountManager.getAccountContract().getContractArtifact()
          : undefined,
        accountManager.getSecretKey(),
      );
    }

    return accountManager;
  }

  /**
   * Internal implementation for retrieving an account by address.
   *
   * This method handles the actual account retrieval logic:
   * - For ZERO address: Returns a signerless account
   * - For other addresses: Retrieves account data from DB and creates AccountManager
   *
   * Subclasses should wrap this with authorization checks as needed.
   *
   * @param address - The account address to retrieve
   * @returns Account instance for the given address
   */
  protected async getAccountFromAddressInternal(
    address: AztecAddress,
  ): Promise<Account> {
    const { secretKey, salt, signingKey, type } =
      await this.db.retrieveAccount(address);
    const accountManager = await this.getAccountManager(
      type,
      secretKey,
      salt,
      signingKey,
    );
    const account = await accountManager.getAccount();

    if (!account) {
      throw new Error(`Account not found in wallet for address: ${address}`);
    }

    return account;
  }

  /**
   * Creates a "fake" stub account for simulation purposes.
   *
   * Used during transaction simulation to bypass actual signature generation
   * while maintaining the correct account address and contract interface.
   * The stub account allows simulating transactions without access to the real private key.
   *
   * @param address - The real account address to create a stub for
   * @returns Stub account, instance, and artifact for simulation
   */
  protected async getFakeAccountDataFor(address: AztecAddress) {
    const originalAccount = await this.getAccountFromAddress(address);
    const originalAddress = originalAccount.getCompleteAddress();
    const contractInstance = await this.pxe.getContractInstance(
      originalAddress.address,
    );
    if (!contractInstance) {
      throw new Error(
        `No contract instance found for address: ${originalAddress.address}`,
      );
    }
    const account = createStubAccount(originalAddress);
    const instance = await getContractInstanceFromInstantiationParams(
      StubAccountContractArtifact,
      {
        salt: Fr.random(),
      },
    );
    return {
      account,
      instance,
      artifact: StubAccountContractArtifact,
    };
  }

  /**
   * Builds simulation overrides for all known accounts in the wallet.
   * This ensures kernelless simulation works for any call that touches
   * account contracts, including sponsored calls with NO_FROM.
   */
  protected async buildAccountOverrides(): Promise<
    Record<
      string,
      { instance: ContractInstanceWithAddress; artifact: ContractArtifact }
    >
  > {
    const accounts = await this.db.listAccounts();
    const contracts: Record<
      string,
      { instance: ContractInstanceWithAddress; artifact: ContractArtifact }
    > = {};

    for (const account of accounts) {
      try {
        const instance = await getContractInstanceFromInstantiationParams(
          StubAccountContractArtifact,
          { salt: Fr.random() },
        );
        contracts[account.item.toString()] = {
          instance,
          artifact: StubAccountContractArtifact,
        };
      } catch {
        // Skip accounts that can't be resolved
      }
    }

    return contracts;
  }

  override getChainInfo(): Promise<ChainInfo> {
    return Promise.resolve(this.chainInfo);
  }

  /**
   * Internal method to retrieve all senders from the address book.
   * This method does not require authorization and returns all stored senders.
   * It also ensures that all stored senders are registered with the PXE.
   *
   * @returns All stored senders with their aliases
   */
  protected async getAddressBookInternal(): Promise<Aliased<AztecAddress>[]> {
    const senders = await this.pxe.getSenders();
    const storedSenders = await this.db.listSenders();

    // Register any stored senders that aren't in PXE
    for (const storedSender of storedSenders) {
      if (
        senders.findIndex((sender) => sender.equals(storedSender.item)) === -1
      ) {
        await this.pxe.registerSender(storedSender.item);
      }
    }

    return storedSenders;
  }

  // ============================================================================
  // EventTarget Implementation
  // ============================================================================
  // Delegates to InteractionManager which implements EventTarget.
  // Allows external code to listen for wallet events (interactions, auth requests).

  dispatchEvent(event: Event): boolean {
    return this.interactionManager.dispatchEvent(event);
  }

  addEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void {
    return this.interactionManager.addEventListener(type, callback, options);
  }

  removeEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions,
  ): void {
    return this.interactionManager.removeEventListener(type, callback, options);
  }

  /**
   * Resolves a pending authorization request with a user response.
   *
   * Called by the UI when the user approves/denies an authorization dialog.
   * Completes the promise that the wallet is waiting on, allowing the operation to proceed or fail.
   *
   * @param response - Authorization response from user interaction
   */
  resolveAuthorization(response: AuthorizationResponse) {
    this.authorizationManager.resolveAuthorization(response);
  }
}
