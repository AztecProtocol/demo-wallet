import { type Account, type ChainInfo, NO_FROM } from "@aztec/aztec.js/account";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import {
  AccountManager,
  TxSimulationResultWithAppOffset,
  type Aliased,
} from "@aztec/aztec.js/wallet";
import { Fq, Fr } from "@aztec/aztec.js/fields";
import { type AztecNode } from "@aztec/aztec.js/node";
import { type Logger } from "@aztec/aztec.js/log";
import { DecodingCache } from "../decoding/decoding-cache";
import { InteractionManager } from "../managers/interaction-manager";
import { AuthorizationManager } from "../managers/authorization-manager";
import type { PXE } from "@aztec/pxe/client/lazy";
import type { AccountType, WalletDB } from "../database/wallet-db";
import type { PromiseWithResolvers } from "@aztec/foundation/promise";
import type { AuthorizationRequest, AuthorizationResponse } from "../types/authorization";
import { EcdsaKAccountContract, EcdsaRAccountContract } from "@aztec/accounts/ecdsa";
import {
  SchnorrAccountContract,
  SchnorrInitializerlessAccountContract,
} from "@aztec/accounts/schnorr";
import {
  createStubSchnorrAccount,
  StubSchnorrAccountContractArtifact,
} from "@aztec/accounts/schnorr/stub";
import {
  createStubEcdsaAccount,
  StubEcdsaAccountContractArtifact,
} from "@aztec/accounts/ecdsa/stub";
import { ContractFunctionInteraction } from "@aztec/aztec.js/contracts";
import { poseidon2Hash } from "@aztec/foundation/crypto/poseidon";
import { Schnorr } from "@aztec/foundation/crypto/schnorr";
import {
  type ContractOverrides,
  ExecutionPayload,
  SimulationOverrides,
  mergeExecutionPayloads,
} from "@aztec/stdlib/tx";
import { getContractClassFromArtifact } from "@aztec/stdlib/contract";
import { BaseWallet, type SimulateViaEntrypointOptions } from "@aztec/wallet-sdk/base-wallet";
import { DefaultEntrypoint } from "@aztec/entrypoints/default";
import { type DefaultAccountEntrypointOptions } from "@aztec/entrypoints/account";

/**
 * Base class for native wallet implementations (external and internal).
 * Provides common functionality for both trusted and untrusted wallet contexts.
 *
 * Mirrors EmbeddedWallet's approach: simulateViaEntrypoint and buildAccountOverrides
 * live here so operations can call back into the wallet without duplicating logic.
 *
 * Subclasses must implement authorization logic appropriate to their trust level:
 * - ExternalWallet: Requires user authorization for all operations
 * - InternalWallet: Auto-approves all operations (trusted GUI)
 */
export abstract class DemoWallet extends BaseWallet implements EventTarget {
  protected decodingCache: DecodingCache;
  protected interactionManager: InteractionManager;
  protected authorizationManager: AuthorizationManager;

  // Stub class ids per account type, populated by initStubClasses() on wallet startup
  // so simulations can override account contracts without redundant class registration.
  protected stubClassIds = new Map<AccountType, Fr>();

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
    this.decodingCache = new DecodingCache(pxe, db);
    this.interactionManager = new InteractionManager(db);
    this.authorizationManager = new AuthorizationManager(
      appId,
      db,
      pendingAuthorizations,
      this.interactionManager,
    );
  }

  /**
   * Hashes and registers the stub class for every supported account type with PXE,
   * populating stubClassIds. Must be called once on wallet initialization before any
   * simulation that relies on buildAccountOverrides.
   */
  async initStubClasses(): Promise<void> {
    const { id: schnorrClassId } = await getContractClassFromArtifact(
      StubSchnorrAccountContractArtifact,
    );
    await this.pxe.registerContractClass(StubSchnorrAccountContractArtifact);

    // ecdsa stubs (k1 and r1) share the same class id
    const { id: ecdsaClassId } = await getContractClassFromArtifact(
      StubEcdsaAccountContractArtifact,
    );
    await this.pxe.registerContractClass(StubEcdsaAccountContractArtifact);

    this.stubClassIds.set("schnorr", schnorrClassId);
    this.stubClassIds.set("schnorr_initializerless", schnorrClassId);
    this.stubClassIds.set("ecdsasecp256k1", ecdsaClassId);
    this.stubClassIds.set("ecdsasecp256r1", ecdsaClassId);
  }

  /**
   * Creates an AccountManager for a given account type and signing key.
   *
   * Initializerless accounts (`schnorr_initializerless`) commit the signing public key
   * into the contract address via an immutables hash and never require an on-chain
   * deployment — their state is materialized locally by simulating the constructor.
   */
  async getAccountManager(
    type: AccountType,
    secret: Fr,
    salt: Fr,
    signingKey: Buffer,
  ): Promise<AccountManager> {
    let contract;
    let immutablesHash;
    let publicKey;
    switch (type) {
      case "schnorr":
        contract = new SchnorrAccountContract(Fq.fromBuffer(signingKey));
        break;
      case "schnorr_initializerless":
        contract = new SchnorrInitializerlessAccountContract(Fq.fromBuffer(signingKey));
        publicKey = await new Schnorr().computePublicKey(Fq.fromBuffer(signingKey));
        immutablesHash = await poseidon2Hash([publicKey.x, publicKey.y]);
        break;
      case "ecdsasecp256k1":
        contract = new EcdsaKAccountContract(signingKey);
        break;
      case "ecdsasecp256r1":
        contract = new EcdsaRAccountContract(signingKey);
        break;
      default:
        throw new Error(`Unknown account type ${type}`);
    }

    const accountManager = await AccountManager.create(this, secret, contract, {
      salt,
      immutablesHash,
    });

    const instance = accountManager.getInstance();
    const existingInstance = await this.pxe.getContractInstance(instance.address);
    if (!existingInstance) {
      const existingArtifact = await this.pxe.getContractArtifact(instance.currentContractClassId);
      const artifact =
        existingArtifact ?? (await accountManager.getAccountContract().getContractArtifact());
      await this.registerContract(
        instance,
        !existingArtifact ? artifact : undefined,
        accountManager.getSecretKey(),
      );
      if (type === "schnorr_initializerless") {
        const constructor = artifact.functions.find((f) => f.name === "constructor");
        if (!constructor) {
          throw new Error(
            "Could not create SchnorrInitializerlessAccountContract: constructor ABI not found",
          );
        }
        // Materialize the account's public key into local state. No tx is sent.
        const storeCall = new ContractFunctionInteraction(this, instance.address, constructor, [
          publicKey!.x,
          publicKey!.y,
        ]);
        await storeCall.simulate({ from: instance.address });
      }
    }

    return accountManager;
  }

  protected async getAccountFromAddressInternal(address: AztecAddress): Promise<Account> {
    const { secretKey, salt, signingKey, type } = await this.db.retrieveAccount(address);
    const accountManager = await this.getAccountManager(type, secretKey, salt, signingKey);
    const account = await accountManager.getAccount();
    if (!account) {
      throw new Error(`Account not found in wallet for address: ${address}`);
    }
    return account;
  }

  /**
   * Builds contract overrides for all accounts whose addresses appear in `scopes`,
   * replacing their account contracts with type-appropriate stub implementations.
   * Mirrors EmbeddedWallet.buildAccountOverrides.
   */
  protected async buildAccountOverrides(scopes: AztecAddress[]): Promise<ContractOverrides> {
    const accounts = await this.db.listAccounts();
    const contracts: ContractOverrides = {};

    const filtered = accounts.filter((acc) => scopes.some((addr) => addr.equals(acc.item)));

    for (const account of filtered) {
      const address = account.item;
      const { type } = await this.db.retrieveAccount(address);
      const stubClassId = this.stubClassIds.get(type);
      if (!stubClassId) {
        throw new Error(
          `Stub class for account type '${type}' was not registered at wallet init. ` +
            `This is a bug — initStubClasses should cover every supported AccountType.`,
        );
      }

      const originalAccount = await this.getAccountFromAddress(address);
      const completeAddress = originalAccount.getCompleteAddress();
      const contractInstance = await this.pxe.getContractInstance(completeAddress.address);
      if (!contractInstance) {
        throw new Error(
          `No contract instance found for address: ${completeAddress.address} during ` +
            `account override building. This is a bug!`,
        );
      }

      contracts[address.toString()] = {
        instance: { ...contractInstance, currentContractClassId: stubClassId },
      };
    }

    return contracts;
  }

  /**
   * Simulates via a stub account entrypoint, bypassing real account authorization.
   * Mirrors EmbeddedWallet.simulateViaEntrypoint — operations call this instead of
   * housing their own copy of the logic.
   */
  protected override async simulateViaEntrypoint(
    executionPayload: ExecutionPayload,
    opts: SimulateViaEntrypointOptions,
  ): Promise<TxSimulationResultWithAppOffset> {
    const { from, feeOptions, additionalScopes, skipTxValidation, skipFeeEnforcement, sendMessagesAs } = opts;
    const scopes = this.scopesFrom(from, additionalScopes);
    const senderForTags = this.senderForTagsFrom(from, sendMessagesAs);

    const feeExecutionPayload = await feeOptions.walletFeePaymentMethod?.getExecutionPayload();
    const finalExecutionPayload = feeExecutionPayload
      ? mergeExecutionPayloads([feeExecutionPayload, executionPayload])
      : executionPayload;
    const chainInfo = await this.getChainInfo();

    const accountOverrides = await this.buildAccountOverrides(scopes);
    const overrides = new SimulationOverrides({ contracts: accountOverrides });

    let txRequest;
    if (from === NO_FROM) {
      const entrypoint = new DefaultEntrypoint();
      txRequest = await entrypoint.createTxExecutionRequest(
        finalExecutionPayload,
        feeOptions.gasSettings,
        chainInfo,
      );
    } else {
      const { type } = await this.db.retrieveAccount(from);
      const originalAccount = await this.getAccountFromAddress(from);
      const completeAddress = originalAccount.getCompleteAddress();
      const isEcdsa = type === "ecdsasecp256k1" || type === "ecdsasecp256r1";
      const stubAccount = isEcdsa
        ? createStubEcdsaAccount(completeAddress)
        : createStubSchnorrAccount(completeAddress);
      const executionOptions: DefaultAccountEntrypointOptions = {
        txNonce: Fr.random(),
        cancellable: this.cancellableTransactions,
        feePaymentMethodOptions: feeOptions.accountFeePaymentMethodOptions!,
      };
      txRequest = await stubAccount.createTxExecutionRequest(
        finalExecutionPayload,
        feeOptions.gasSettings,
        chainInfo,
        executionOptions,
      );
    }

    const result = await this.pxe.simulateTx(txRequest, {
      simulatePublic: true,
      skipFeeEnforcement,
      skipTxValidation,
      overrides,
      scopes,
      senderForTags,
    });
    const appCallOffset = await this.computeAppCallOffset(from, feeOptions);
    return TxSimulationResultWithAppOffset.fromResultAndOffset(result, appCallOffset);
  }

  override getChainInfo(): Promise<ChainInfo> {
    return Promise.resolve(this.chainInfo);
  }

  protected async getAddressBookInternal(): Promise<Aliased<AztecAddress>[]> {
    const senders = await this.pxe.getSenders();
    const storedSenders = await this.db.listSenders();

    for (const storedSender of storedSenders) {
      if (senders.findIndex((sender) => sender.equals(storedSender.item)) === -1) {
        await this.pxe.registerSender(storedSender.item);
      }
    }

    return storedSenders;
  }

  // ============================================================================
  // EventTarget — delegates to InteractionManager
  // ============================================================================

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

  resolveAuthorization(response: AuthorizationResponse) {
    this.authorizationManager.resolveAuthorization(response);
  }
}
