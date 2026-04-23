import { AztecAddress } from "@aztec/aztec.js/addresses";
import { Fr, Fq } from "@aztec/aztec.js/fields";
import { type Aliased } from "@aztec/aztec.js/wallet";
import {
  type GrantedCapability,
  type GrantedAccountsCapability,
  type GrantedContractsCapability,
  type GrantedSimulationCapability,
  type GrantedTransactionCapability,
  type GrantedDataCapability,
} from "@aztec/aztec.js/wallet";
import { type Logger } from "@aztec/foundation/log";
import { type AztecAsyncMap, type AztecAsyncKVStore } from "@aztec/kv-store";
import { WalletInteraction, type WalletInteractionType } from "../types/wallet-interaction";
import { jsonStringify } from "@aztec/foundation/json-rpc";
import { TxSimulationResult } from "@aztec/stdlib/tx";

export const AccountTypes = ["schnorr", "ecdsasecp256r1", "ecdsasecp256k1"] as const;
export type AccountType = (typeof AccountTypes)[number];

/** Per-function timing from simulation/proving */
interface FunctionTiming {
  functionName: string;
  time: number;
  oracles?: Record<string, { times: number[] }>;
}

/** Timings structure from simulation/proving stats */
interface StatsTimings {
  sync?: number;
  publicSimulation?: number;
  validation?: number;
  proving?: number;
  perFunction: FunctionTiming[];
  unaccounted: number;
  total: number;
  // Wall-clock phases injected at origin for sendTx
  simulation?: number;
  sending?: number;
  mining?: number;
}

/** Execution stats stored per interaction (enriched with wall-clock phases at origin) */
export interface StoredStats {
  timings: StatsTimings;
}

export class WalletDB {
  private constructor(
    private accounts: AztecAsyncMap<string, Buffer>,
    private aliases: AztecAsyncMap<string, Buffer>,
    private bridgedFeeJuice: AztecAsyncMap<string, Buffer>,
    private interactions: AztecAsyncMap<string, Buffer>,
    private authorizations: AztecAsyncMap<string, Buffer>,
    private txPayloadData: AztecAsyncMap<string, string>,
    private logger: Logger,
  ) {}

  static init(store: AztecAsyncKVStore, logger: Logger) {
    const accounts = store.openMap<string, Buffer>("accounts");
    const aliases = store.openMap<string, Buffer>("aliases");
    const bridgedFeeJuice = store.openMap<string, Buffer>("bridgedFeeJuice");
    const interactions = store.openMap<string, Buffer>("interactions");
    const authorizations = store.openMap<string, Buffer>("authorizations");
    const txPayloadData = store.openMap<string, string>("txPayloadData");
    return new WalletDB(
      accounts,
      aliases,
      bridgedFeeJuice,
      interactions,
      authorizations,
      txPayloadData,
      logger,
    );
  }

  async pushBridgedFeeJuice(
    recipient: AztecAddress,
    secret: Fr,
    amount: bigint,
    leafIndex: bigint,
  ) {
    let stackPointer =
      (await this.bridgedFeeJuice.getAsync(`${recipient.toString()}:stackPointer`))?.readInt8() ||
      0;
    stackPointer++;
    await this.bridgedFeeJuice.set(
      `${recipient.toString()}:${stackPointer}`,
      Buffer.from(`${amount.toString()}:${secret.toString()}:${leafIndex.toString()}`),
    );
    await this.bridgedFeeJuice.set(
      `${recipient.toString()}:stackPointer`,
      Buffer.from([stackPointer]),
    );
    this.logger.info(
      `Pushed ${amount} fee juice for recipient ${recipient.toString()}. Stack pointer ${stackPointer}`,
    );
  }

  async popBridgedFeeJuice(recipient: AztecAddress) {
    let stackPointer =
      (await this.bridgedFeeJuice.getAsync(`${recipient.toString()}:stackPointer`))?.readInt8() ||
      0;
    const result = await this.bridgedFeeJuice.getAsync(`${recipient.toString()}:${stackPointer}`);
    if (!result) {
      throw new Error(
        `No stored fee juice available for recipient ${recipient.toString()}. Please provide claim amount and secret. Stack pointer ${stackPointer}`,
      );
    }
    const [amountStr, secretStr, leafIndexStr] = result.toString().split(":");
    await this.bridgedFeeJuice.set(
      `${recipient.toString()}:stackPointer`,
      Buffer.from([--stackPointer]),
    );
    this.logger.info(
      `Retrieved ${amountStr} fee juice for recipient ${recipient.toString()}. Stack pointer ${stackPointer}`,
    );
    return {
      amount: BigInt(amountStr),
      secret: secretStr,
      leafIndex: BigInt(leafIndexStr),
    };
  }

  async storeAccount(
    address: AztecAddress,
    {
      type,
      secretKey,
      salt,
      alias,
      signingKey,
    }: {
      type: AccountType;
      secretKey: Fr;
      salt: Fr;
      signingKey: Fq | Buffer;
      alias: string | undefined;
    },
  ) {
    if (alias) {
      await this.aliases.set(`accounts:${alias}`, Buffer.from(address.toString()));
    }
    await this.accounts.set(`${address.toString()}:type`, Buffer.from(type));
    await this.accounts.set(`${address.toString()}:sk`, secretKey.toBuffer());
    await this.accounts.set(`${address.toString()}:salt`, salt.toBuffer());
    await this.accounts.set(
      `${address.toString()}:signingKey`,
      "toBuffer" in signingKey ? signingKey.toBuffer() : signingKey,
    );
    // New accounts are undeployed by default
    await this.accounts.set(`${address.toString()}:deployed`, Buffer.from("false"));
    this.logger.info(
      `Account stored in database with alias${alias ? `es last & ${alias}` : " last"}`,
    );
  }

  async storeSender(address: AztecAddress, alias: string) {
    await this.aliases.set(`senders:${alias}`, Buffer.from(address.toString()));
    this.logger.info(`Sender stored in database with alias ${alias}`);
  }

  async storeAccountMetadata(
    aliasOrAddress: AztecAddress | string,
    metadataKey: string,
    metadata: Buffer,
  ) {
    const { address } = await this.retrieveAccount(aliasOrAddress);
    await this.accounts.set(`${address.toString()}:${metadataKey}`, metadata);
  }

  async retrieveAccountMetadata(aliasOrAddress: AztecAddress | string, metadataKey: string) {
    const { address } = await this.retrieveAccount(aliasOrAddress);
    const result = await this.accounts.getAsync(`${address.toString()}:${metadataKey}`);
    if (!result) {
      throw new Error(
        `Could not find metadata with key ${metadataKey} for account ${aliasOrAddress}`,
      );
    }
    return result;
  }

  async retrieveAccount(address: AztecAddress | string) {
    const secretKeyBuffer = await this.accounts.getAsync(`${address.toString()}:sk`);
    if (!secretKeyBuffer) {
      throw new Error(
        `Could not find ${address}:sk. Account "${address.toString}" does not exist on this wallet.`,
      );
    }
    const secretKey = Fr.fromBuffer(secretKeyBuffer);
    const salt = Fr.fromBuffer(await this.accounts.getAsync(`${address.toString()}:salt`)!);
    const type = (await this.accounts.getAsync(`${address.toString()}:type`)!).toString(
      "utf8",
    ) as AccountType;
    const signingKey = await this.accounts.getAsync(`${address.toString()}:signingKey`)!;
    const deployedBuf = await this.accounts.getAsync(`${address.toString()}:deployed`);
    const deployed = deployedBuf?.toString("utf8") === "true";
    return { address, secretKey, salt, type, signingKey, deployed };
  }

  async markAccountDeployed(address: AztecAddress): Promise<void> {
    await this.accounts.set(`${address.toString()}:deployed`, Buffer.from("true"));
    this.logger.info(`Account ${address.toString()} marked as deployed`);
  }

  async isAccountDeployed(address: AztecAddress): Promise<boolean> {
    const buf = await this.accounts.getAsync(`${address.toString()}:deployed`);
    return buf?.toString("utf8") === "true";
  }

  async listAccounts(opts?: { deployedOnly?: boolean }): Promise<Aliased<AztecAddress>[]> {
    // Collect all account aliases first to avoid interleaving reads across
    // IndexedDB stores (which kills the cursor's transaction).
    const allAccounts: Aliased<AztecAddress>[] = [];
    for await (const [alias, item] of this.aliases.entriesAsync()) {
      if (alias.startsWith("accounts:")) {
        allAccounts.push({
          alias: alias.replace("accounts:", ""),
          item: AztecAddress.fromString(item.toString()),
        });
      }
    }

    if (!opts?.deployedOnly) {
      return allAccounts;
    }

    // Filter to deployed accounts only (safe to read accounts store now)
    const result = [];
    for (const acc of allAccounts) {
      if (await this.isAccountDeployed(acc.item)) {
        result.push(acc);
      }
    }
    return result;
  }

  async listSenders(): Promise<Aliased<AztecAddress>[]> {
    const result = [];
    for await (const [alias, item] of this.aliases.entriesAsync()) {
      if (alias.startsWith("senders:")) {
        result.push({ alias, item: AztecAddress.fromString(item.toString()) });
      }
    }
    return result;
  }

  async deleteAccount(address: AztecAddress) {
    await this.accounts.delete(`${address.toString()}:sk`);
    await this.accounts.delete(`${address.toString()}:salt`);
    await this.accounts.delete(`${address.toString()}:type`);
    await this.accounts.delete(`${address.toString()}:signingKey`);
    const accounts = await this.listAccounts();
    const account = accounts.find((account) => address.equals(account.item));
    await this.aliases.delete(account?.alias);
  }

  async storeInteraction<T extends WalletInteractionType>(interaction: WalletInteraction<T>) {
    await this.interactions.set(interaction.id, interaction.toBuffer());
  }

  async createOrUpdateInteraction(interaction: WalletInteraction<WalletInteractionType>) {
    const { id, status, complete } = interaction;
    const maybeInteractionBuffer = await this.interactions.getAsync(id);
    if (!maybeInteractionBuffer) {
      await this.storeInteraction(interaction);
    } else {
      const storedInteraction = WalletInteraction.fromBuffer(maybeInteractionBuffer);
      storedInteraction.status = status;
      storedInteraction.complete = complete;
      await this.storeInteraction(storedInteraction);
    }
  }

  async listInteractions() {
    const result = [];
    for await (const [_, item] of this.interactions.entriesAsync()) {
      result.push(WalletInteraction.fromBuffer(item));
    }
    // Sort by timestamp descending (most recently updated first)
    return result.sort((a, b) => b.timestamp - a.timestamp);
  }

  async deleteInteraction(id: string) {
    await this.interactions.delete(id);
  }

  async clearInteractions() {
    for await (const [id] of this.interactions.entriesAsync()) {
      await this.interactions.delete(id);
    }
  }

  async storePersistentAuthorization(appId: string, key: string, data: any) {
    const fullKey = `${appId}:${key}`;
    await this.authorizations.set(fullKey, Buffer.from(jsonStringify(data)));
  }

  async retrievePersistentAuthorization(appId: string, key: string): Promise<any | undefined> {
    const fullKey = `${appId}:${key}`;
    const result = await this.authorizations.getAsync(fullKey);
    if (!result) {
      return undefined;
    }
    return JSON.parse(result.toString());
  }

  /**
   * Store capability grants by translating them to persistent authorization entries.
   * Additive: upserts new keys without clearing existing ones.
   * Also appends the granted capabilities to __requested__ for cumulative tracking.
   *
   * @param appId - Application ID
   * @param granted - Granted capabilities to store
   * @param requestedCapabilities - All capabilities that were requested (including denied ones), for __requested__ tracking
   */
  async storeCapabilityGrants(
    appId: string,
    granted: GrantedCapability[],
    requestedCapabilities?: GrantedCapability[],
  ): Promise<void> {
    this.logger.info(
      `[storeCapabilityGrants] Called for ${appId} with ${granted.length} capabilities`,
    );

    // Store the new capability grants (additive — upserts on top of existing)
    const allKeys: string[] = [];

    for (const capability of granted) {
      const keys = this.capabilityToStorageKeys(capability);
      allKeys.push(...keys);

      // Extract capability-specific data that authorization checks expect
      const capabilityData = this.extractCapabilityData(capability);

      // Note: we intentionally do NOT persist the full `capability` object here.
      // Storing it per-key caused quadratic blowup when syncing to cookies
      // (N keys × the whole capability serialized N times). The capability
      // shape is fully recoverable from the set of storage keys via
      // `reconstructCapabilitiesFromKeys`, so only per-key metadata and the
      // small `capabilityData` payload (e.g. the accounts list for getAccounts)
      // needs to live here.
      for (const key of keys) {
        await this.storePersistentAuthorization(appId, key, {
          persistent: true,
          grantedAt: Date.now(),
          ...capabilityData,
        });
      }
    }

    this.logger.info(
      `Stored capability grants for ${appId}: ${granted.length} capabilities, ${allKeys.length} storage keys: ${allKeys.join(", ")}`,
    );

    // Track all requested capabilities (including denied ones) in __requested__
    // so the Apps tab can display them for future re-granting
    const toTrack = requestedCapabilities ?? granted;
    const requestedKeys = toTrack.flatMap((cap) => this.capabilityToStorageKeys(cap));
    if (requestedKeys.length > 0) {
      await this.appendRequestedKeys(appId, requestedKeys);
    }
  }

  /**
   * Revoke a specific capability by deleting its authorization keys.
   * Does NOT remove from __requested__ — the capability remains visible for re-granting.
   */
  async revokeCapability(appId: string, capability: GrantedCapability): Promise<void> {
    const keys = this.capabilityToStorageKeys(capability);
    for (const key of keys) {
      const fullKey = `${appId}:${key}`;
      await this.authorizations.delete(fullKey);
    }
    this.logger.info(
      `Revoked capability ${capability.type} for ${appId} (${keys.length} keys deleted)`,
    );
  }

  /**
   * Append storage keys to the cumulative __requested__ set for an app.
   * This tracks everything the app has ever requested, regardless of approval.
   * The set only grows — keys are never removed from __requested__.
   */
  async appendRequestedKeys(appId: string, keys: string[]): Promise<void> {
    const existing = await this.getRequestedKeys(appId);
    const merged = new Set([...existing, ...keys]);
    const fullKey = `${appId}:__requested__`;
    await this.authorizations.set(fullKey, Buffer.from(JSON.stringify([...merged])));
  }

  /**
   * Get all storage keys that have ever been requested by an app.
   * Returns the cumulative __requested__ set.
   */
  async getRequestedKeys(appId: string): Promise<string[]> {
    const fullKey = `${appId}:__requested__`;
    const raw = await this.authorizations.getAsync(fullKey);
    if (!raw) return [];
    return JSON.parse(Buffer.from(raw).toString()) as string[];
  }

  /**
   * Reconstruct capabilities from the __requested__ keys.
   * Returns everything the app has ever requested (for the Apps tab display).
   */
  async getRequestedCapabilities(appId: string): Promise<GrantedCapability[]> {
    const keys = await this.getRequestedKeys(appId);
    if (keys.length === 0) return [];
    return this.reconstructCapabilitiesFromKeyList(keys);
  }

  /**
   * Extract capability-specific data that authorization checks expect.
   * For example, getAccountFromAddress() expects an 'accounts' array for AccountsCapability.
   *
   * @param capability - The granted capability
   * @returns Object with capability-specific data fields
   */
  private extractCapabilityData(capability: GrantedCapability): Record<string, any> {
    switch (capability.type) {
      case "accounts": {
        const accountsCap = capability as GrantedAccountsCapability;
        // Store accounts in the format that getAccountFromAddress() expects
        return {
          accounts: accountsCap.accounts.map((acc) => ({
            alias: acc.alias,
            item: acc.item.toString(),
          })),
        };
      }
      default:
        return {};
    }
  }

  /**
   * Convert a granted capability to one or more storage keys for 1:1 mapping with ad-hoc approvals.
   *
   * Examples:
   * - AccountsCapability { canGet: true } → ["getAccounts"]
   * - ContractsCapability { contracts: [addr1, addr2], canRegister: true } → ["registerContract:addr1", "registerContract:addr2"]
   * - ContractsCapability { contracts: '*', canRegister: true } → ["registerContract:*"]
   * - SimulationCapability { transactions: { scope: '*' } } → ["simulateTx:*"]
   * - SimulationCapability { utilities: { scope: '*' } } → ["simulateUtility:*"]
   * - SimulationCapability { transactions: { scope: [{ contract: addr, function: 'foo' }] } } → ["simulateTx:addr:foo"]
   *
   * Note: profileTx is not included as it's a debugging operation. Apps that need it can request separately.
   */
  public capabilityToStorageKeys(capability: GrantedCapability): string[] {
    const keys: string[] = [];

    switch (capability.type) {
      case "accounts": {
        const accountsCap = capability as GrantedAccountsCapability;
        if (accountsCap.canGet) {
          keys.push("getAccounts");
        }
        if (accountsCap.canCreateAuthWit) {
          keys.push("createAuthWit");
        }
        break;
      }

      case "contracts": {
        const contractsCap = capability as GrantedContractsCapability;
        const contracts =
          contractsCap.contracts === "*"
            ? ["*"]
            : contractsCap.contracts.map((addr) => addr.toString());

        if (contractsCap.canRegister) {
          keys.push(...contracts.map((c) => `registerContract:${c}`));
        }
        if (contractsCap.canGetMetadata) {
          keys.push(...contracts.map((c) => `getContractMetadata:${c}`));
        }
        break;
      }

      case "contractClasses": {
        const contractClassesCap = capability as any; // GrantedContractClassesCapability
        const classes =
          contractClassesCap.classes === "*"
            ? ["*"]
            : contractClassesCap.classes.map((classId: any) => classId.toString());

        if (contractClassesCap.canGetMetadata) {
          keys.push(...classes.map((c) => `getContractClassMetadata:${c}`));
        }
        break;
      }

      case "simulation": {
        const simCap = capability as GrantedSimulationCapability;

        if (simCap.transactions) {
          if (simCap.transactions.scope === "*") {
            // For wildcard transaction simulations, only cover simulateTx
            // (profileTx is a debugging operation and can be requested separately if needed)
            keys.push("simulateTx:*");
          } else {
            // Pattern-based scopes - only generate keys for simulateTx
            // (utilities use simulateUtility, not simulateTx)
            for (const pattern of simCap.transactions.scope) {
              const contract = pattern.contract === "*" ? "*" : pattern.contract.toString();
              const func = pattern.function;
              keys.push(`simulateTx:${contract}:${func}`);
            }
          }
        }

        if (simCap.utilities) {
          if (simCap.utilities.scope === "*") {
            keys.push("simulateUtility:*");
          } else {
            // Pattern-based scopes - only generate keys for simulateUtility
            for (const pattern of simCap.utilities.scope) {
              const contract = pattern.contract === "*" ? "*" : pattern.contract.toString();
              const func = pattern.function;
              keys.push(`simulateUtility:${contract}:${func}`);
            }
          }
        }
        break;
      }

      case "transaction": {
        const txCap = capability as GrantedTransactionCapability;

        if (txCap.scope === "*") {
          keys.push("sendTx:*");
        } else {
          // Pattern-based scopes
          for (const pattern of txCap.scope) {
            const contract = pattern.contract === "*" ? "*" : pattern.contract.toString();
            const func = pattern.function;
            keys.push(`sendTx:${contract}:${func}`);
          }
        }
        break;
      }

      case "data": {
        const dataCap = capability as GrantedDataCapability;

        if (dataCap.addressBook) {
          keys.push("getAddressBook");
        }

        if (dataCap.privateEvents) {
          const contracts =
            dataCap.privateEvents.contracts === "*"
              ? ["*"]
              : dataCap.privateEvents.contracts.map((addr) => addr.toString());

          keys.push(...contracts.map((c) => `getPrivateEvents:${c}`));
        }
        break;
      }
    }

    return keys;
  }

  /**
   * Revoke all capability grants for an app by removing all persistent authorizations.
   *
   * @param appId - Application ID to revoke capabilities for
   */
  async revokeAllCapabilities(appId: string): Promise<void> {
    const keysToDelete: string[] = [];
    const prefix = `${appId}:`;

    for await (const key of this.authorizations.keysAsync({
      start: prefix,
      end: `${prefix}\uffff`,
    })) {
      keysToDelete.push(key);
    }

    // Delete all keys
    for (const key of keysToDelete) {
      await this.authorizations.delete(key);
    }

    this.logger.info(`Revoked ${keysToDelete.length} persistent authorizations for ${appId}`);
  }

  /**
   * Reconstruct granted capabilities from stored authorization keys.
   * Reverse-engineers capabilities by grouping storage keys by pattern.
   *
   * @param appId - Application ID to get capabilities for
   * @returns Array of granted capabilities
   */
  async reconstructCapabilitiesFromKeys(appId: string): Promise<GrantedCapability[]> {
    // Collect all authorization keys for this app (excluding metadata)
    const prefix = `${appId}:`;
    const keys: string[] = [];
    for await (const key of this.authorizations.keysAsync({
      start: prefix,
      end: `${prefix}\uffff`,
    })) {
      const storageKey = key.substring(prefix.length);
      if (!storageKey.startsWith("__")) {
        keys.push(storageKey);
      }
    }

    return this.reconstructCapabilitiesFromKeyList(keys, appId);
  }

  /**
   * Reconstruct capabilities from a list of storage keys.
   * Shared logic used by both reconstructCapabilitiesFromKeys (granted) and
   * getRequestedCapabilities (__requested__).
   *
   * @param keys - Storage keys to reconstruct from
   * @param appId - Optional appId for fetching stored data (accounts, contacts). If omitted, data-dependent fields use defaults.
   */
  reconstructCapabilitiesFromKeyList(keys: string[], appId?: string): Promise<GrantedCapability[]> {
    return this._reconstructCapabilities(keys, appId);
  }

  private async _reconstructCapabilities(
    keys: string[],
    appId?: string,
  ): Promise<GrantedCapability[]> {
    const capabilities: GrantedCapability[] = [];

    // Group keys by method to reconstruct capabilities
    const accountKeys = keys.filter((k) => k === "getAccounts" || k === "createAuthWit");
    const contractKeys = keys.filter(
      (k) => k.startsWith("registerContract:") || k.startsWith("getContractMetadata:"),
    );
    const contractClassKeys = keys.filter((k) => k.startsWith("getContractClassMetadata:"));
    const simulateTxKeys = keys.filter((k) => k.startsWith("simulateTx:"));
    const simulateUtilityKeys = keys.filter((k) => k.startsWith("simulateUtility:"));
    const sendTxKeys = keys.filter((k) => k.startsWith("sendTx:"));
    const addressBookKeys = keys.filter((k) => k === "getAddressBook");
    const privateEventsKeys = keys.filter((k) => k.startsWith("getPrivateEvents:"));

    // Reconstruct AccountsCapability
    if (accountKeys.length > 0) {
      const canGet = accountKeys.includes("getAccounts");
      const canCreateAuthWit = accountKeys.includes("createAuthWit");

      // Fetch accounts from stored data if appId available
      let accounts: Array<{ alias: string; item: AztecAddress }> = [];
      if (canGet && appId) {
        const data = await this.retrievePersistentAuthorization(appId, "getAccounts");
        accounts = (data?.accounts || []).map((acc: any) => ({
          alias: acc.alias,
          item: typeof acc.item === "string" ? AztecAddress.fromString(acc.item) : acc.item,
        }));
      }

      capabilities.push({
        type: "accounts",
        canGet,
        canCreateAuthWit,
        accounts,
      } as any); // GrantedAccountsCapability
    }

    // Reconstruct ContractsCapability with per-contract permission granularity.
    // Produce separate capabilities for each permission combination so that
    // capabilityToStorageKeys round-trips accurately (e.g. a contract with only
    // register doesn't get a phantom metadata key).
    if (contractKeys.length > 0) {
      const registerAddrs = new Set(
        contractKeys.filter((k) => k.startsWith("registerContract:")).map((k) => k.split(":")[1]),
      );
      const metadataAddrs = new Set(
        contractKeys
          .filter((k) => k.startsWith("getContractMetadata:"))
          .map((k) => k.split(":")[1]),
      );

      // Check for wildcards
      const hasRegisterWild = registerAddrs.has("*");
      const hasMetadataWild = metadataAddrs.has("*");

      if (hasRegisterWild || hasMetadataWild) {
        // Wildcard case — single capability
        capabilities.push({
          type: "contracts",
          contracts: "*" as const,
          canRegister: hasRegisterWild,
          canGetMetadata: hasMetadataWild,
        });
      } else {
        // Group addresses by their permission signature
        const allAddrs = new Set([...registerAddrs, ...metadataAddrs]);
        const bothAddrs: AztecAddress[] = [];
        const registerOnlyAddrs: AztecAddress[] = [];
        const metadataOnlyAddrs: AztecAddress[] = [];

        for (const a of allAddrs) {
          const hasReg = registerAddrs.has(a);
          const hasMeta = metadataAddrs.has(a);
          const addr = AztecAddress.fromString(a);
          if (hasReg && hasMeta) bothAddrs.push(addr);
          else if (hasReg) registerOnlyAddrs.push(addr);
          else metadataOnlyAddrs.push(addr);
        }

        if (bothAddrs.length > 0) {
          capabilities.push({
            type: "contracts",
            contracts: bothAddrs,
            canRegister: true,
            canGetMetadata: true,
          });
        }
        if (registerOnlyAddrs.length > 0) {
          capabilities.push({
            type: "contracts",
            contracts: registerOnlyAddrs,
            canRegister: true,
            canGetMetadata: false,
          });
        }
        if (metadataOnlyAddrs.length > 0) {
          capabilities.push({
            type: "contracts",
            contracts: metadataOnlyAddrs,
            canRegister: false,
            canGetMetadata: true,
          });
        }
      }
    }

    // Reconstruct ContractClassesCapability
    if (contractClassKeys.length > 0) {
      const classIds = contractClassKeys.map((k) => k.split(":")[1]);
      const classes = classIds.includes("*")
        ? ("*" as const)
        : classIds.filter((c) => c !== "*").map((c) => Fr.fromString(c));

      capabilities.push({
        type: "contractClasses",
        classes,
        canGetMetadata: true,
      });
    }

    // Reconstruct SimulationCapability
    if (simulateTxKeys.length > 0 || simulateUtilityKeys.length > 0) {
      const simCap: any = { type: "simulation" };

      if (simulateTxKeys.length > 0) {
        const hasWildcard = simulateTxKeys.some((k) => k === "simulateTx:*");
        if (hasWildcard) {
          simCap.transactions = { scope: "*" as const };
        } else {
          const patterns = simulateTxKeys.map((k) => {
            const parts = k.split(":");
            const contract = parts[1] === "*" ? ("*" as const) : AztecAddress.fromString(parts[1]);
            const func = parts[2] || "*";
            return { contract, function: func };
          });
          simCap.transactions = { scope: patterns };
        }
      }

      if (simulateUtilityKeys.length > 0) {
        const hasWildcard = simulateUtilityKeys.some((k) => k === "simulateUtility:*");
        if (hasWildcard) {
          simCap.utilities = { scope: "*" as const };
        } else {
          const patterns = simulateUtilityKeys.map((k) => {
            const parts = k.split(":");
            const contract = parts[1] === "*" ? ("*" as const) : AztecAddress.fromString(parts[1]);
            const func = parts[2] || "*";
            return { contract, function: func };
          });
          simCap.utilities = { scope: patterns };
        }
      }

      capabilities.push(simCap);
    }

    // Reconstruct TransactionCapability
    if (sendTxKeys.length > 0) {
      const hasWildcard = sendTxKeys.some((k) => k === "sendTx:*");
      if (hasWildcard) {
        capabilities.push({
          type: "transaction",
          scope: "*" as const,
        });
      } else {
        const patterns = sendTxKeys.map((k) => {
          const parts = k.split(":");
          const contract = parts[1] === "*" ? ("*" as const) : AztecAddress.fromString(parts[1]);
          const func = parts[2] || "*";
          return { contract, function: func };
        });
        capabilities.push({
          type: "transaction",
          scope: patterns,
        });
      }
    }

    // Reconstruct DataCapability
    if (addressBookKeys.length > 0 || privateEventsKeys.length > 0) {
      const dataCap: any = { type: "data" };

      if (addressBookKeys.length > 0) {
        // Fetch contacts from stored data if appId available
        if (appId) {
          const data = await this.retrievePersistentAuthorization(appId, "getAddressBook");
          const contacts = (data?.contacts || []).map((contact: any) => ({
            alias: contact.alias,
            item:
              typeof contact.item === "string"
                ? AztecAddress.fromString(contact.item)
                : contact.item,
          }));
          dataCap.addressBook = { contacts };
        } else {
          dataCap.addressBook = true;
        }
      }

      if (privateEventsKeys.length > 0) {
        const contractAddrs = privateEventsKeys.map((k) => k.split(":")[1]);
        const contracts = contractAddrs.includes("*")
          ? ("*" as const)
          : contractAddrs.filter((c) => c !== "*").map((c) => AztecAddress.fromString(c));

        dataCap.privateEvents = { contracts };
      }

      capabilities.push(dataCap);
    }

    return capabilities;
  }

  /**
   * List all apps that have persistent authorizations.
   * Uses __requested__ and __behavior__ markers to reliably extract appIds
   * (appIds may contain colons, e.g. URLs).
   */
  async listAuthorizedApps(): Promise<string[]> {
    const appIds = new Set<string>();
    const MARKERS = [":__requested__", ":__behavior__"];
    for await (const key of this.authorizations.keysAsync()) {
      for (const marker of MARKERS) {
        if (key.endsWith(marker)) {
          appIds.add(key.slice(0, -marker.length));
        }
      }
    }
    return Array.from(appIds);
  }

  /**
   * Update the getAccounts authorization for an app
   */
  async updateAccountAuthorization(appId: string, accounts: Aliased<AztecAddress>[]) {
    await this.storePersistentAuthorization(appId, "getAccounts", { accounts });
  }

  /**
   * Update the getAddressBook authorization for an app
   */
  async updateAddressBookAuthorization(appId: string, contacts: Aliased<AztecAddress>[]) {
    await this.storePersistentAuthorization(appId, "getAddressBook", {
      contacts,
    });
  }

  /**
   * Revoke a specific authorization by its full key
   */
  async revokeAuthorization(key: string) {
    this.logger.info(`Attempting to revoke authorization with key: ${key}`);
    const existsBefore = await this.authorizations.getAsync(key);
    this.logger.info(
      `Authorization value before deletion: ${existsBefore ? "exists" : "not found"}`,
    );
    await this.authorizations.delete(key);
    const existsAfter = await this.authorizations.getAsync(key);
    this.logger.info(
      `Authorization value after deletion: ${existsAfter ? "still exists (ERROR!)" : "successfully deleted"}`,
    );
  }

  /**
   * Revoke all persistent authorizations for an app
   */
  async revokeAppAuthorizations(appId: string) {
    const prefix = `${appId}:`;
    const keysToDelete: string[] = [];
    for await (const key of this.authorizations.keysAsync({
      start: prefix,
      end: `${prefix}\uffff`,
    })) {
      keysToDelete.push(key);
    }

    for (const key of keysToDelete) {
      await this.authorizations.delete(key);
    }

    this.logger.info(
      `Revoked all authorizations for appId ${appId} (${keysToDelete.length} keys deleted)`,
    );
  }

  async storeTxPayloadData(
    payloadHash: string,
    simulationResult: TxSimulationResult,
    metadata?: {
      from?: string;
      embeddedPaymentMethodFeePayer?: string;
      stats?: StoredStats;
    },
  ) {
    const data = jsonStringify({
      simulationResult,
      metadata,
    });
    await this.txPayloadData.set(payloadHash, data);
    this.logger.info(`Transaction simulation stored for payload hash ${payloadHash}`);
  }

  async getTxPayloadData(payloadHash: string): Promise<
    | {
        simulationResult: TxSimulationResult;
        metadata?: {
          from?: string;
          embeddedPaymentMethodFeePayer?: string;
          stats?: StoredStats;
        };
      }
    | undefined
  > {
    const result = await this.txPayloadData.getAsync(payloadHash);
    if (!result) {
      return undefined;
    }
    return JSON.parse(result);
  }

  /**
   * Store stats associated with a payload hash.
   * Works for txs that went through simulation (upserts the metadata.stats field)
   * and for txs that didn't simulate (e.g. createAccount — stores stats-only record).
   */
  async updateTxPayloadStats(payloadHash: string, stats: StoredStats): Promise<void> {
    const existing = await this.getTxPayloadData(payloadHash);
    const metadata = existing?.metadata ?? {};
    metadata.stats = stats;

    const data = jsonStringify({
      ...(existing ?? {}),
      metadata,
    });
    await this.txPayloadData.set(payloadHash, data);
    this.logger.debug(`Payload stats stored for ${payloadHash}`);
  }

  async storeUtilityTrace(payloadHash: string, trace: any, stats?: any) {
    const data = jsonStringify({
      utilityTrace: trace,
      stats,
    });
    await this.txPayloadData.set(payloadHash, data);
    this.logger.info(`Utility trace stored for payload hash ${payloadHash}`);
  }

  async getUtilityTrace(payloadHash: string): Promise<{ trace: any; stats?: any } | undefined> {
    const result = await this.txPayloadData.getAsync(payloadHash);
    if (!result) {
      return undefined;
    }
    const parsed = JSON.parse(result);
    if (!parsed.utilityTrace) {
      return undefined;
    }
    return { trace: parsed.utilityTrace, stats: parsed.stats };
  }

  /**
   * Get all authorization keys for an app (for debugging/admin purposes).
   * Returns all keys that start with the appId prefix.
   */
  async getAllAuthorizationKeys(appId: string): Promise<string[]> {
    const prefix = `${appId}:`;
    const keys: string[] = [];
    for await (const key of this.authorizations.keysAsync({
      start: prefix,
      end: `${prefix}\uffff`,
    })) {
      keys.push(key.substring(prefix.length));
    }
    return keys;
  }

  /**
   * Check if specific storage keys exist for an app.
   * Returns a map of storageKey -> exists (boolean).
   */
  async checkAuthorizationKeys(
    appId: string,
    storageKeys: string[],
  ): Promise<Map<string, boolean>> {
    const results = new Map<string, boolean>();
    for (const key of storageKeys) {
      const exists = (await this.retrievePersistentAuthorization(appId, key)) !== undefined;
      results.set(key, exists);
    }
    return results;
  }

  /**
   * Store the authorization behavior for an app (mode and expiration).
   * This determines whether the app operates in strict or permissive mode.
   */
  async storeAppAuthorizationBehavior(
    appId: string,
    mode: "strict" | "permissive",
    duration: number,
  ): Promise<void> {
    const key = `${appId}:__behavior__`;
    const expiresAt = Date.now() + duration;
    await this.authorizations.set(key, Buffer.from(jsonStringify({ mode, expiresAt })));
    this.logger.info(
      `Authorization behavior stored for ${appId}: mode=${mode}, expiresAt=${new Date(expiresAt).toISOString()}`,
    );
  }

  /**
   * Retrieve the authorization behavior for an app.
   * Returns undefined if not set or expired.
   */
  async getAppAuthorizationBehavior(
    appId: string,
  ): Promise<{ mode: "strict" | "permissive"; expiresAt: number } | undefined> {
    const key = `${appId}:__behavior__`;
    const result = await this.authorizations.getAsync(key);
    if (!result) {
      return undefined;
    }
    const data = JSON.parse(result.toString());

    // Check if expired
    if (data.expiresAt && Date.now() > data.expiresAt) {
      this.logger.info(`Authorization behavior expired for ${appId}`);
      // Clean up expired behavior
      await this.authorizations.delete(key);
      return undefined;
    }

    return data;
  }

  /**
   * Export all authorization entries for all apps as a portable structure.
   * Each app gets a record of storageKey → parsed JSON value.
   * Used to sync capability grants to cookies.
   */
  async exportAllAuthorizations(): Promise<
    Array<{ appId: string; entries: Record<string, unknown> }>
  > {
    // First, collect all app IDs
    const appIds = await this.listAuthorizedApps();
    const result: Array<{ appId: string; entries: Record<string, unknown> }> = [];

    for (const appId of appIds) {
      const prefix = `${appId}:`;
      const entries: Record<string, unknown> = {};

      for await (const [key, value] of this.authorizations.entriesAsync({
        start: prefix,
        end: `${prefix}\uffff`,
      })) {
        const storageKey = key.substring(prefix.length);
        try {
          entries[storageKey] = JSON.parse(value.toString());
        } catch {
          entries[storageKey] = value.toString();
        }
      }

      if (Object.keys(entries).length > 0) {
        result.push({ appId, entries });
      }
    }

    return result;
  }

  /**
   * Import authorization entries from a portable structure into the DB.
   * Full overwrite: replaces local entries with cookie data for each app present in the import.
   * Keys present in the cookie but missing locally are created.
   * Keys present locally but missing in the cookie are deleted (the cookie is authoritative).
   * Used to bootstrap capability grants from cookies at PXE init.
   */
  async importAllAuthorizations(
    apps: Array<{ appId: string; entries: Record<string, unknown> }>,
  ): Promise<number> {
    let updated = 0;

    for (const { appId, entries } of apps) {
      const prefix = `${appId}:`;

      // Collect existing keys for this app so we can delete stale ones
      const existingKeys = new Set<string>();
      for await (const key of this.authorizations.keysAsync({
        start: prefix,
        end: `${prefix}\uffff`,
      })) {
        existingKeys.add(key);
      }

      // Write all entries from the cookie
      for (const [storageKey, value] of Object.entries(entries)) {
        const fullKey = `${appId}:${storageKey}`;
        await this.authorizations.set(fullKey, Buffer.from(jsonStringify(value)));
        existingKeys.delete(fullKey); // Mark as seen
        updated++;
      }

      // Delete local keys that are no longer in the cookie (revoked on the other side)
      for (const staleKey of existingKeys) {
        await this.authorizations.delete(staleKey);
        updated++;
      }
    }

    this.logger.info(
      `Imported authorization data for ${apps.length} app(s) (${updated} entries processed)`,
    );
    return updated;
  }
}
