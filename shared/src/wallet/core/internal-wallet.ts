import { NO_FROM, type Account } from "@aztec/aztec.js/account";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import {
  type Aliased,
  type DeployAccountOptions,
  type SendOptions,
  type GrantedCapability,
  TxSimulationResultWithAppOffset,
} from "@aztec/aztec.js/wallet";
import { type Fr } from "@aztec/aztec.js/fields";
import type { AccountType } from "../database/wallet-db";
import {
  WalletInteraction,
  WalletUpdateEvent,
  type WalletInteractionType,
} from "../types/wallet-interaction";

import { collectOffchainEffects, type ExecutionPayload, TxStatus } from "@aztec/stdlib/tx";
import type { DecodedExecutionTrace } from "../decoding/tx-callstack-decoder";
import { TxDecodingService } from "../decoding/tx-decoding-service";

import { DemoWallet } from "./demo-wallet.ts";
import {
  NO_WAIT,
  toSendOptions,
  type InteractionWaitOptions,
  type SendReturn,
  extractOffchainOutput,
  getGasLimits,
} from "@aztec/aztec.js/contracts";
import { waitForTx } from "@aztec/aztec.js/node";
import { CallAuthorizationRequest } from "@aztec/aztec.js/authorization";
import { GasSettings } from "@aztec/stdlib/gas";

// Enriched account type for internal use
export type InternalAccount = Aliased<AztecAddress> & {
  type: AccountType;
  deployed: boolean;
};

/**
 * 1. Skips all authorization checks (trusted internal GUI)
 * 2. Returns enriched data (e.g., account types)
 * 3. Provides additional internal-only methods
 */
export class InternalWallet extends DemoWallet {
  // Override getAccountFromAddress to skip authorization check
  protected override async getAccountFromAddress(address: AztecAddress): Promise<Account> {
    // Internal wallet is trusted, skip authorization and use base implementation
    return this.getAccountFromAddressInternal(address);
  }

  // Override getAccounts to return enriched data with account types
  override async getAccounts(): Promise<InternalAccount[]> {
    // Skip authorization via override above
    const accounts = await this.db.listAccounts();

    // Enrich with account type and deployed state
    return Promise.all(
      accounts.map(async (acc) => {
        const { type, deployed } = await this.db.retrieveAccount(acc.item);
        return { ...acc, type, deployed };
      }),
    );
  }

  override async registerSender(address: AztecAddress, alias: string): Promise<AztecAddress> {
    // Store sender in database
    await this.db.storeSender(address, alias);
    // Register with PXE
    const result = await this.pxe.registerSender(address);
    // Emit wallet-update so the UI and cookie sync pick up the new contact
    const interaction = WalletInteraction.from({
      type: "registerSender",
      status: "SUCCESS",
      complete: true,
      title: `Registered contact ${alias}`,
    });
    await this.interactionManager.storeAndEmit(interaction);
    return result;
  }

  override async getAddressBook(): Promise<Aliased<AztecAddress>[]> {
    return this.getAddressBookInternal();
  }

  async createAccount(
    alias: string,
    type: AccountType,
    secret: Fr,
    salt: Fr,
    signingKey: Buffer,
  ): Promise<void> {
    const interaction = WalletInteraction.from({
      type: "createAccount",
      status: "CREATING",
      complete: false,
      title: `Creating account ${alias}`,
    });
    await this.interactionManager.storeAndEmit(interaction);

    try {
      const accountManager = await this.getAccountManager(type, secret, salt, signingKey);
      await this.db.storeAccount(accountManager.address, {
        type,
        secretKey: secret,
        salt,
        alias,
        signingKey,
      });

      await this.interactionManager.storeAndEmit(
        interaction.update({
          status: "CREATED",
          complete: true,
          description: `Address ${accountManager.address.toString()}`,
        }),
      );
    } catch (error: any) {
      await this.interactionManager.storeAndEmit(
        interaction.update({
          status: "ERROR",
          complete: true,
          description: `Failed: ${error.message || String(error)}`,
        }),
      );
      throw error;
    }
  }

  async deployAccount(address: AztecAddress): Promise<void> {
    const interaction = WalletInteraction.from({
      type: "deployAccount",
      status: "SIMULATING",
      complete: false,
      title: `Deploying account`,
    });
    await this.interactionManager.storeAndEmit(interaction);

    try {
      const { secretKey, salt, signingKey, type } = await this.db.retrieveAccount(address);
      const accountManager = await this.getAccountManager(type, secretKey, salt, signingKey);

      await this.interactionManager.storeAndEmit(
        interaction.update({
          description: `Address ${address.toString()}`,
        }),
      );

      const deployMethod = await accountManager.getDeployMethod();
      const opts: DeployAccountOptions = {
        from: NO_FROM,
        skipClassPublication: true,
        skipInstancePublication: true,
      };

      const executionPayload = await deployMethod.request({
        ...opts,
        deployer: AztecAddress.ZERO,
      });

      const feeOptions = await this.completeFeeOptions({
        from: opts.from,
        feePayer: executionPayload.feePayer,
        gasSettings: opts.fee?.gasSettings,
        forEstimation: true,
      });

      const simulationResult = await this.simulateViaEntrypoint(executionPayload, {
        from: opts.from,
        feeOptions,
        additionalScopes: [address],
        skipTxValidation: true,
      });

      // Mark simulation complete so the live timeline can measure its duration
      await this.interactionManager.storeAndEmit(
        interaction.update({ status: "REQUESTING AUTHORIZATION" }),
      );

      const offchainEffects = collectOffchainEffects(simulationResult.privateExecutionResult);
      const authWitnesses = await Promise.all(
        offchainEffects.map(async (effect) => {
          try {
            const authRequest = await CallAuthorizationRequest.fromFields(effect.data);
            return this.createAuthWit(authRequest.onBehalfOf, {
              consumer: effect.contractAddress,
              innerHash: authRequest.innerHash,
            });
          } catch {
            return undefined;
          }
        }),
      );
      for (const authwit of authWitnesses) {
        if (authwit) {
          executionPayload.authWitnesses.push(authwit);
        }
      }
      const estimated = getGasLimits(simulationResult);
      this.log.verbose(
        `Estimated gas limits for tx: DA=${estimated.gasLimits.daGas} L2=${estimated.gasLimits.l2Gas} teardownDA=${estimated.teardownGasLimits.daGas} teardownL2=${estimated.teardownGasLimits.l2Gas}`,
      );
      const gasSettings = GasSettings.from({
        ...opts.fee?.gasSettings,
        maxFeesPerGas: feeOptions.gasSettings.maxFeesPerGas,
        maxPriorityFeesPerGas: feeOptions.gasSettings.maxPriorityFeesPerGas,
        gasLimits: opts.fee?.gasSettings?.gasLimits ?? estimated.gasLimits,
        teardownGasLimits: opts.fee?.gasSettings?.teardownGasLimits ?? estimated.teardownGasLimits,
      });
      const sendOptions = {
        ...(await toSendOptions(opts)),
        additionalScopes: [address],
        fee: { ...opts.fee, gasSettings },
      };
      await this.sendTx(executionPayload, sendOptions, interaction);

      await this.db.markAccountDeployed(address);
      await this.interactionManager.storeAndEmit(
        interaction.update({ status: "DEPLOYED", complete: true }),
      );
    } catch (error: any) {
      await this.interactionManager.storeAndEmit(
        interaction.update({
          status: "ERROR",
          complete: true,
          description: `Failed: ${error.message || String(error)}`,
        }),
      );
      throw error;
    }
  }

  override async sendTx<W extends InteractionWaitOptions = undefined>(
    executionPayload: ExecutionPayload,
    opts: SendOptions<W>,
    interaction?: WalletInteraction<WalletInteractionType>,
  ): Promise<SendReturn<W>> {
    const fee = await this.completeFeeOptions({
      from: opts.from,
      feePayer: executionPayload.feePayer,
      gasSettings: opts.fee?.gasSettings,
    });
    const txRequest = await this.createTxExecutionRequestFromPayloadAndFee(
      executionPayload,
      opts.from,
      fee,
    );

    // Helper to format duration
    const formatDuration = (ms: number): string => {
      if (ms < 1000) return `${Math.round(ms)}ms`;
      return `${(ms / 1000).toFixed(1)}s`;
    };

    // Track proving time
    const provingStartTime = Date.now();
    await this.interactionManager.storeAndEmit(
      interaction.update({
        status: "PROVING",
      }),
    );
    const provenTx = await this.pxe.proveTx(
      txRequest,
      { scopes: this.scopesFrom(opts.from, opts.additionalScopes) },
    );
    const provingTime = Date.now() - provingStartTime;

    const offchainOutput = extractOffchainOutput(
      provenTx.getOffchainEffects(),
      provenTx.publicInputs.constants.anchorBlockHeader.globalVariables.timestamp,
    );
    const tx = await provenTx.toTx();
    const txHash = tx.getTxHash();
    if (await this.aztecNode.getTxEffect(txHash)) {
      throw new Error(`A settled tx with equal hash ${txHash.toString()} exists.`);
    }

    // Track sending time
    const sendingStartTime = Date.now();
    await this.interactionManager.storeAndEmit(
      interaction.update({
        status: "SENDING",
      }),
    );
    this.log.debug(`Sending transaction ${txHash}`);
    await this.aztecNode.sendTx(tx).catch((err) => {
      throw this.contextualizeError(err, JSON.stringify(tx));
    });
    const sendingTime = Date.now() - sendingStartTime;
    this.log.info(`Sent transaction ${txHash}`);

    // If wait is NO_WAIT, return txHash immediately
    if (opts.wait === NO_WAIT) {
      const timingSummary = `Prove: ${formatDuration(provingTime)} | Send: ${formatDuration(sendingTime)}`;
      await this.interactionManager.storeAndEmit(
        interaction.update({ description: timingSummary }),
      );
      if (interaction) {
        const rawStats = provenTx.stats;
        await this.db.updateTxPayloadStats(interaction.id, {
          ...rawStats,
          timings: { ...rawStats.timings, sending: sendingTime },
        });
      }
      return { txHash, ...offchainOutput } as SendReturn<W>;
    }

    // Otherwise, wait for the full receipt (default behavior on wait: undefined)
    await this.interactionManager.storeAndEmit(interaction.update({ status: "MINING" }));
    const miningStartTime = Date.now();
    const waitOpts = typeof opts.wait === "object" ? opts.wait : undefined;
    const receipt = await waitForTx(this.aztecNode, txHash, {
      ...waitOpts,
      waitForStatus: TxStatus.PROPOSED,
    });
    const miningTime = Date.now() - miningStartTime;

    const timingSummary = `Prove: ${formatDuration(provingTime)} | Send: ${formatDuration(sendingTime)} | Mine: ${formatDuration(miningTime)}`;
    await this.interactionManager.storeAndEmit(interaction.update({ description: timingSummary }));
    if (interaction) {
      const rawStats = provenTx.stats;
      await this.db.updateTxPayloadStats(interaction.id, {
        ...rawStats,
        timings: {
          ...rawStats.timings,
          sending: sendingTime,
          mining: miningTime,
        },
      });
    }

    return { receipt, ...offchainOutput } as SendReturn<W>;
  }

  // Internal-only method: Delete account
  async deleteAccount(address: AztecAddress) {
    await this.db.deleteAccount(address);
  }

  // Internal-only: Get all interactions (unfiltered)
  getInteractions() {
    return this.db.listInteractions();
  }

  deleteInteraction(id: string) {
    return this.db.deleteInteraction(id);
  }

  clearInteractions() {
    return this.db.clearInteractions();
  }

  async getExecutionTrace(interactionId: string): Promise<
    | {
        trace?: DecodedExecutionTrace;
        stats?: any;
        from?: string;
        embeddedPaymentMethodFeePayer?: string;
      }
    | undefined
  > {
    // First check if it's a utility trace (simple trace)
    const utilityData = await this.db.getUtilityTrace(interactionId);
    if (utilityData) {
      return {
        trace: utilityData.trace as DecodedExecutionTrace,
        stats: utilityData.stats,
      };
    }

    // Otherwise, retrieve the stored simulation result (full tx)
    const data = await this.db.getTxPayloadData(interactionId);
    if (!data) {
      return undefined;
    }

    // Stats-only record (e.g. createAccount — no simulation was run)
    if (!data.simulationResult) {
      return {
        stats: data.metadata?.stats,
        from: data.metadata?.from,
      };
    }

    // Use the shared decoding cache from DemoWallet
    const decodingService = new TxDecodingService(this.decodingCache, this.log);
    const parsedSimulationResult = TxSimulationResultWithAppOffset.schema.parse(
      data.simulationResult,
    );

    const { executionTrace } = await decodingService.decodeTransaction(parsedSimulationResult);
    // stats is already enriched at origin with simulation/sending/mining wall-clock times.
    // Fall back to simStats for simulate-only interactions.
    const stats = data.metadata?.stats ?? parsedSimulationResult.stats;

    return {
      trace: executionTrace,
      stats,
      from: data.metadata?.from,
      embeddedPaymentMethodFeePayer: data.metadata?.embeddedPaymentMethodFeePayer,
    };
  }

  // App authorization management methods
  async listAuthorizedApps(): Promise<string[]> {
    return await this.db.listAuthorizedApps();
  }

  async getAppCapabilities(
    appId: string,
  ): Promise<{ requested: GrantedCapability[]; granted: GrantedCapability[] }> {
    const [requested, granted] = await Promise.all([
      this.db.getRequestedCapabilities(appId),
      this.db.reconstructCapabilitiesFromKeys(appId),
    ]);
    return { requested, granted };
  }

  async resolveContractNames(addresses: string[]): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    for (const addrStr of addresses) {
      result[addrStr] = await this.decodingCache.getAddressAlias(AztecAddress.fromString(addrStr));
    }
    return result;
  }

  async capabilityToStorageKeys(capability: GrantedCapability): Promise<string[]> {
    return this.db.capabilityToStorageKeys(capability);
  }

  async storeCapabilityGrants(
    appId: string,
    granted: GrantedCapability[],
    requestedCapabilities?: GrantedCapability[],
  ): Promise<void> {
    await this.db.storeCapabilityGrants(appId, granted, requestedCapabilities);
    this.emitCapabilityChange();
  }

  async revokeCapability(appId: string, capability: GrantedCapability): Promise<void> {
    await this.db.revokeCapability(appId, capability);
    this.emitCapabilityChange();
  }

  async updateAccountAuthorization(
    appId: string,
    accounts: Aliased<AztecAddress>[],
  ): Promise<void> {
    await this.db.updateAccountAuthorization(appId, accounts);
    this.emitCapabilityChange();
  }

  async updateAddressBookAuthorization(
    appId: string,
    contacts: Aliased<AztecAddress>[],
  ): Promise<void> {
    await this.db.updateAddressBookAuthorization(appId, contacts);
    this.emitCapabilityChange();
  }

  async revokeAuthorization(key: string): Promise<void> {
    await this.db.revokeAuthorization(key);
    this.emitCapabilityChange();
  }

  async revokeAppAuthorizations(appId: string): Promise<void> {
    await this.db.revokeAppAuthorizations(appId);
    this.emitCapabilityChange();
  }

  /**
   * Emit a wallet-update event so cookie sync picks up capability changes
   * made through the Apps tab UI (storeCapabilityGrants, revoke, etc.).
   */
  private emitCapabilityChange(): void {
    const interaction = WalletInteraction.from({
      type: "capabilityChange" as any,
      status: "SUCCESS",
      complete: true,
      title: "Capability change",
    });
    this.interactionManager.dispatchEvent(new WalletUpdateEvent(interaction));
  }
}
