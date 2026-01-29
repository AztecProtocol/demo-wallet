import { type Account } from "@aztec/aztec.js/account";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import {
  type Aliased,
  type DeployAccountOptions,
  type SendOptions,
  type GrantedCapability,
  type AppCapabilities,
} from "@aztec/aztec.js/wallet";
import { type Fr } from "@aztec/aztec.js/fields";
import type { AccountType } from "../database/wallet-db";
import {
  WalletInteraction,
  type WalletInteractionType,
} from "../types/wallet-interaction";

import {
  type ExecutionPayload,
  TxHash,
  TxSimulationResult,
} from "@aztec/stdlib/tx";
import type { DecodedExecutionTrace } from "../decoding/tx-callstack-decoder";
import { TxDecodingService } from "../decoding/tx-decoding-service";

import { inspect } from "node:util";
import { BaseNativeWallet } from "./base-native-wallet.ts";
import {
  NO_WAIT,
  toSendOptions,
  type InteractionWaitOptions,
  type SendReturn,
} from "@aztec/aztec.js/contracts";
import { waitForTx } from "@aztec/aztec.js/node";

// Enriched account type for internal use
export type InternalAccount = Aliased<AztecAddress> & { type: AccountType };

/**
 * 1. Skips all authorization checks (trusted internal GUI)
 * 2. Returns enriched data (e.g., account types)
 * 3. Provides additional internal-only methods
 */
export class InternalWallet extends BaseNativeWallet {
  // Override getAccountFromAddress to skip authorization check
  protected override async getAccountFromAddress(
    address: AztecAddress,
  ): Promise<Account> {
    // Internal wallet is trusted, skip authorization and use base implementation
    return this.getAccountFromAddressInternal(address);
  }

  // Override getAccounts to return enriched data with account types
  override async getAccounts(): Promise<InternalAccount[]> {
    // Skip authorization via override above
    const accounts = await this.db.listAccounts();

    // Enrich with account type information
    return Promise.all(
      accounts.map(async (acc) => ({
        ...acc,
        type: (await this.db.retrieveAccount(acc.item)).type,
      })),
    );
  }

  override async registerSender(
    address: AztecAddress,
    alias: string,
  ): Promise<AztecAddress> {
    // Store sender in database
    await this.db.storeSender(address, alias);
    // Register with PXE
    return await this.pxe.registerSender(address);
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
      title: `Creating and deploying account ${alias}`,
    });
    await this.interactionManager.storeAndEmit(interaction);

    try {
      const accountManager = await this.getAccountManager(
        type,
        secret,
        salt,
        signingKey,
      );
      await this.db.storeAccount(accountManager.address, {
        type,
        secretKey: secret,
        salt,
        alias,
        signingKey,
      });
      await this.interactionManager.storeAndEmit(
        interaction.update({
          status: "PREPARING ACCOUNT",
          description: `Address ${accountManager.address.toString()}`,
        }),
      );

      const deployMethod = await accountManager.getDeployMethod();
      const { prepareForFeePayment } =
        await import("../utils/sponsored-fpc.ts");
      const paymentMethod = await prepareForFeePayment(this);
      const opts: DeployAccountOptions = {
        from: AztecAddress.ZERO,
        fee: {
          paymentMethod,
        },
        skipClassPublication: true,
        skipInstancePublication: true,
      };

      const exec = await deployMethod.request({
        ...opts,
        deployer: AztecAddress.ZERO,
      });
      await this.sendTx(exec, await toSendOptions(opts), interaction);

      await this.interactionManager.storeAndEmit(
        interaction.update({ status: "DEPLOYED", complete: true }),
      );
    } catch (error: any) {
      // Update interaction with error status
      await this.interactionManager.storeAndEmit(
        interaction.update({
          status: "ERROR",
          complete: true,
          description: `Failed: ${error.message || String(error)}`,
        }),
      );
      // Re-throw so the UI can also handle it
      throw error;
    }
  }

  override async sendTx<W extends InteractionWaitOptions = undefined>(
    executionPayload: ExecutionPayload,
    opts: SendOptions<W>,
    interaction?: WalletInteraction<WalletInteractionType>,
  ): Promise<SendReturn<W>> {
    const fee = await this.completeFeeOptions(
      opts.from,
      executionPayload.feePayer,
      opts.fee?.gasSettings,
    );
    const txRequest = await this.createTxExecutionRequestFromPayloadAndFee(
      executionPayload,
      opts.from,
      fee,
    );
    await this.interactionManager.storeAndEmit(
      interaction.update({
        status: "PROVING",
      }),
    );
    const provenTx = await this.pxe.proveTx(txRequest);
    const tx = await provenTx.toTx();
    const txHash = tx.getTxHash();
    if (await this.aztecNode.getTxEffect(txHash)) {
      throw new Error(
        `A settled tx with equal hash ${txHash.toString()} exists.`,
      );
    }
    await this.interactionManager.storeAndEmit(
      interaction.update({
        status: "SENDING",
      }),
    );
    this.log.debug(`Sending transaction ${txHash}`);
    await this.aztecNode.sendTx(tx).catch((err) => {
      throw this.contextualizeError(err, inspect(tx));
    });
    this.log.info(`Sent transaction ${txHash}`);

    // If wait is NO_WAIT, return txHash immediately
    if (opts.wait === NO_WAIT) {
      return txHash as SendReturn<W>;
    }

    // Otherwise, wait for the full receipt (default behavior on wait: undefined)
    const waitOpts = typeof opts.wait === "object" ? opts.wait : undefined;
    return (await waitForTx(this.aztecNode, txHash, waitOpts)) as SendReturn<W>;
  }

  // Internal-only method: Delete account
  async deleteAccount(address: AztecAddress) {
    await this.db.deleteAccount(address);
  }

  // Internal-only: Get all interactions (unfiltered)
  getInteractions() {
    return this.db.listInteractions();
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
    const data = await this.db.getTxSimulation(interactionId);
    if (!data) {
      return undefined;
    }

    // Use the shared decoding cache from BaseNativeWallet
    const decodingService = new TxDecodingService(this.decodingCache);
    const parsedSimulationResult = TxSimulationResult.schema.parse(
      data.simulationResult,
    );

    const { executionTrace } = await decodingService.decodeTransaction(
      parsedSimulationResult,
    );
    return {
      trace: executionTrace,
      stats: parsedSimulationResult.stats,
      from: data.metadata?.from,
      embeddedPaymentMethodFeePayer:
        data.metadata?.embeddedPaymentMethodFeePayer,
    };
  }

  // App authorization management methods
  async listAuthorizedApps(): Promise<string[]> {
    return await this.db.listAuthorizedApps();
  }

  async getAppCapabilities(appId: string): Promise<GrantedCapability[]> {
    return await this.db.reconstructCapabilitiesFromKeys(appId);
  }

  async storeCapabilityGrants(
    appId: string,
    manifest: AppCapabilities,
    granted: GrantedCapability[]
  ): Promise<void> {
    await this.db.storeCapabilityGrants(appId, granted);
  }

  async updateAccountAuthorization(
    appId: string,
    accounts: Aliased<AztecAddress>[],
  ): Promise<void> {
    await this.db.updateAccountAuthorization(appId, accounts);
  }

  async updateAddressBookAuthorization(
    appId: string,
    contacts: Aliased<AztecAddress>[],
  ): Promise<void> {
    await this.db.updateAddressBookAuthorization(appId, contacts);
  }

  async revokeAuthorization(key: string): Promise<void> {
    await this.db.revokeAuthorization(key);
  }

  async revokeAppAuthorizations(appId: string): Promise<void> {
    await this.db.revokeAppAuthorizations(appId);
  }
}
