import {
  ExternalOperation,
  type PrepareResult,
  type PersistenceConfig,
} from "./base-operation";
import type {
  AppCapabilities,
  WalletCapabilities,
  GrantedCapability,
  CAPABILITY_VERSION,
} from "@aztec/aztec.js/wallet";
import {
  WalletInteraction,
  type WalletInteractionType,
} from "../types/wallet-interaction";
import type { WalletDB } from "../database/wallet-db";
import type { InteractionManager } from "../managers/interaction-manager";
import type { AuthorizationManager } from "../managers/authorization-manager";
import type { DecodingCache } from "../decoding/decoding-cache";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import type { PXE } from "@aztec/pxe/server";

// Arguments tuple for the operation
type RequestCapabilitiesArgs = [AppCapabilities];

// Result type for the operation
type RequestCapabilitiesResult = WalletCapabilities;

// Execution data stored between prepare and execute phases
interface RequestCapabilitiesExecutionData {
  manifest: AppCapabilities;
  granted: GrantedCapability[];
}

// Display data for authorization UI
type RequestCapabilitiesDisplayData = {
  manifest: AppCapabilities;
  newCapabilityIndices: number[]; // Indices of capabilities that are new/not yet granted
  contractNames: Record<string, string>; // Map of contract address -> resolved name (plain object for IPC)
  // Map of storage key -> whether it's already granted (plain object for IPC)
  existingGrants: Record<string, boolean>;
};

/**
 * RequestCapabilities operation implementation.
 *
 * Handles capability grant authorization with the following features:
 * - Displays all requested capabilities to the user
 * - User approves/denies capabilities
 * - Translates granted capabilities to persistent authorization storage
 * - Returns WalletCapabilities response
 */
export class RequestCapabilitiesOperation extends ExternalOperation<
  RequestCapabilitiesArgs,
  RequestCapabilitiesResult,
  RequestCapabilitiesExecutionData,
  RequestCapabilitiesDisplayData
> {
  protected interactionManager: InteractionManager;
  private grantedCapabilities?: GrantedCapability[];

  constructor(
    private pxe: PXE,
    private db: WalletDB,
    interactionManager: InteractionManager,
    private authorizationManager: AuthorizationManager,
    private decodingCache: DecodingCache,
  ) {
    super();
    this.interactionManager = interactionManager;
  }

  async check(
    manifest: AppCapabilities,
  ): Promise<RequestCapabilitiesResult | undefined> {
    // Calculate all storage keys that would be needed for the requested capabilities
    const allKeys: string[] = [];
    const capabilityKeys = new Map<number, string[]>(); // Map capability index to its keys
    const nonTxCapabilityIndices: number[] = []; // Track non-transaction capability indices

    for (let i = 0; i < manifest.capabilities.length; i++) {
      const capability = manifest.capabilities[i];
      const keys = this.db.capabilityToStorageKeys(capability as any);
      allKeys.push(...keys);
      capabilityKeys.set(i, keys);

      // Track non-transaction capabilities
      if (capability.type !== "transaction") {
        nonTxCapabilityIndices.push(i);
      }
    }

    // Check which keys already exist
    const keyStatus = await this.db.checkAuthorizationKeys(
      this.authorizationManager.appId,
      allKeys,
    );

    // Count missing keys for NON-TRANSACTION capabilities only
    // Transaction capabilities ALWAYS require approval, so they don't count toward "new" capabilities
    let nonTxMissingCount = 0;
    for (const capIdx of nonTxCapabilityIndices) {
      const keys = capabilityKeys.get(capIdx)!;
      for (const key of keys) {
        if (!keyStatus.get(key)) {
          // Special handling for registerContract: check if contract is already registered in PXE
          if (key.startsWith("registerContract:")) {
            const contractAddress = key.split(":")[1];
            try {
              const instance = await this.pxe.getContractInstance(
                AztecAddress.fromString(contractAddress),
              );
              if (instance) {
                // Contract is registered in PXE, treat as granted even if no persistent auth
                continue; // Skip counting this as missing
              }
            } catch (e) {
              // Contract not found in PXE, count as missing
            }
          }
          nonTxMissingCount++;
        }
      }
    }

    // If all NON-TRANSACTION capabilities are already granted, return early
    // Transaction capabilities always require approval, so they don't block early return
    if (nonTxMissingCount === 0 && nonTxCapabilityIndices.length > 0) {
      // Reconstruct granted capabilities with actual stored data
      const granted: GrantedCapability[] = [];

      for (let i = 0; i < manifest.capabilities.length; i++) {
        const requestedCap = manifest.capabilities[i];
        const keys = capabilityKeys.get(i)!;

        // Get the first key's data to extract stored information
        if (keys.length > 0) {
          const storedData = await this.db.retrievePersistentAuthorization(
            this.authorizationManager.appId,
            keys[0],
          );

          // For accounts capability, we need to extract the accounts list from stored data
          if (requestedCap.type === "accounts" && storedData?.accounts) {
            // Convert stored accounts (with string items) back to AztecAddress objects
            const accounts = (
              storedData.accounts as Array<{ alias: string; item: string }>
            ).map((acc) => ({
              alias: acc.alias,
              item: AztecAddress.fromString(acc.item),
            }));

            granted.push({
              type: "accounts",
              accounts,
              canCreateAuthWit: (requestedCap as any).canCreateAuthWit ?? false,
            } as any);
          } else {
            // For other capabilities, just use the requested capability as granted
            granted.push(requestedCap as any);
          }
        }
      }

      return {
        version: "1.0" as typeof CAPABILITY_VERSION,
        granted,
        wallet: {
          name: "Demo Wallet",
          version: "1.0.0",
        },
      };
    }

    // Some capabilities are new/missing, will need to show UI
    return undefined;
  }

  async createInteraction(
    manifest: AppCapabilities,
  ): Promise<WalletInteraction<WalletInteractionType>> {
    const interaction = WalletInteraction.from({
      type: "requestCapabilities",
      status: "PREPARING",
      complete: false,
      title: `Request Capabilities for ${manifest.metadata.name}`,
      description: `${manifest.metadata.name} is requesting permissions`,
    });

    await this.interactionManager.storeAndEmit(interaction);

    return interaction;
  }

  async prepare(
    manifest: AppCapabilities,
  ): Promise<
    PrepareResult<
      RequestCapabilitiesResult,
      RequestCapabilitiesDisplayData,
      RequestCapabilitiesExecutionData
    >
  > {
    // Calculate which capabilities are new (not already granted)
    const newCapabilityIndices: number[] = [];
    // Track which storage keys already exist
    const existingGrants = new Map<string, boolean>();

    for (let i = 0; i < manifest.capabilities.length; i++) {
      const capability = manifest.capabilities[i];
      const keys = this.db.capabilityToStorageKeys(capability as any);

      let keyStatus: Map<string, boolean>;

      // For simulation and transaction capabilities, check if ad-hoc authorizations cover them
      if (
        capability.type === "simulation" ||
        capability.type === "transaction"
      ) {
        // Build pattern array for checking against stored function calls
        const patterns: Array<{
          contract: string;
          function: string;
          method: string;
        }> = [];

        if (capability.type === "simulation") {
          const simCap = capability as any;
          if (simCap.transactions?.scope !== "*") {
            for (const pattern of simCap.transactions?.scope || []) {
              patterns.push({
                contract:
                  pattern.contract === "*" ? "*" : pattern.contract.toString(),
                function: pattern.function,
                method: "simulateTx",
              });
            }
          }
          if (simCap.utilities?.scope !== "*") {
            for (const pattern of simCap.utilities?.scope || []) {
              patterns.push({
                contract:
                  pattern.contract === "*" ? "*" : pattern.contract.toString(),
                function: pattern.function,
                method: "simulateUtility",
              });
            }
          }
        } else if (capability.type === "transaction") {
          const txCap = capability as any;
          if (txCap.scope !== "*") {
            for (const pattern of txCap.scope) {
              patterns.push({
                contract:
                  pattern.contract === "*" ? "*" : pattern.contract.toString(),
                function: pattern.function,
                method: "sendTx",
              });
            }
          }
        }

        // Build storage keys from patterns: method:contract:function
        const patternKeys = patterns.map(
          (p) => `${p.method}:${p.contract}:${p.function}`,
        );
        keyStatus = await this.db.checkAuthorizationKeys(
          this.authorizationManager.appId,
          patternKeys,
        );
      } else {
        // For other capabilities, use simple key existence check
        keyStatus = await this.db.checkAuthorizationKeys(
          this.authorizationManager.appId,
          keys,
        );

        // Special handling for registerContract: check if contracts are already registered in PXE
        if (capability.type === "contracts") {
          for (const [key, exists] of keyStatus.entries()) {
            if (!exists && key.startsWith("registerContract:")) {
              const contractAddress = key.split(":")[1];
              try {
                const instance = await this.pxe.getContractInstance(
                  AztecAddress.fromString(contractAddress),
                );
                if (instance) {
                  // Contract is registered in PXE, treat as granted
                  keyStatus.set(key, true);
                }
              } catch (e) {
                // Contract not found in PXE, keep as missing
              }
            }
          }
        }
      }

      const hasMissingKeys = Array.from(keyStatus.values()).some(
        (exists) => !exists,
      );

      // Store all key statuses in existingGrants map
      for (const [key, exists] of keyStatus.entries()) {
        existingGrants.set(key, exists);
      }

      // Transaction capabilities are NEVER counted as "new" because they ALWAYS require user approval
      // (wallet security policy in AuthorizationManager)
      if (hasMissingKeys && capability.type !== "transaction") {
        newCapabilityIndices.push(i);
      }
    }

    // Collect all contract addresses from all capabilities and resolve their names
    const contractAddresses = new Set<string>();
    for (const capability of manifest.capabilities) {
      if (capability.type === "contracts") {
        const contractsCap = capability as any;
        if (contractsCap.contracts !== "*") {
          for (const addr of contractsCap.contracts) {
            contractAddresses.add(addr.toString());
          }
        }
      } else if (capability.type === "simulation") {
        const simCap = capability as any;
        if (simCap.transactions?.scope !== "*") {
          for (const pattern of simCap.transactions?.scope || []) {
            if (pattern.contract !== "*") {
              contractAddresses.add(pattern.contract.toString());
            }
          }
        }
        if (simCap.utilities?.scope !== "*") {
          for (const pattern of simCap.utilities?.scope || []) {
            if (pattern.contract !== "*") {
              contractAddresses.add(pattern.contract.toString());
            }
          }
        }
      } else if (capability.type === "transaction") {
        const txCap = capability as any;
        if (txCap.scope !== "*") {
          for (const pattern of txCap.scope) {
            if (pattern.contract !== "*") {
              contractAddresses.add(pattern.contract.toString());
            }
          }
        }
      } else if (capability.type === "data") {
        const dataCap = capability as any;
        if (dataCap.privateEvents?.contracts !== "*") {
          for (const addr of dataCap.privateEvents?.contracts || []) {
            contractAddresses.add(addr.toString());
          }
        }
      }
    }

    // Resolve contract names using the decoding cache
    const contractNames = new Map<string, string>();
    for (const addressStr of contractAddresses) {
      const address = AztecAddress.fromString(addressStr);
      const name = await this.decodingCache.getAddressAlias(address);
      contractNames.set(addressStr, name);
    }

    // Convert Maps to plain objects for IPC serialization
    const contractNamesObj = Object.fromEntries(contractNames);
    const existingGrantsObj = Object.fromEntries(existingGrants);

    // Display data shows the full manifest plus which capabilities are new
    return {
      displayData: {
        manifest,
        newCapabilityIndices,
        contractNames: contractNamesObj,
        existingGrants: existingGrantsObj,
      },
      executionData: { manifest, granted: [] }, // granted will be filled by authorization
      // No persistence config - we'll manually store capabilities in execute
    };
  }

  async requestAuthorization(
    displayData: RequestCapabilitiesDisplayData,
    _persistence?: PersistenceConfig,
  ): Promise<void> {
    await this.emitProgress("REQUESTING AUTHORIZATION", undefined, false, {
      title: `Request Capabilities for ${displayData.manifest.metadata.name}`,
    });

    const itemId = crypto.randomUUID();
    const response = await this.authorizationManager.requestAuthorization([
      {
        id: itemId,
        appId: this.authorizationManager.appId,
        method: "requestCapabilities",
        params: displayData,
        timestamp: Date.now(),
        // No persistence here - we'll store the capabilities manually in execute
      },
    ]);

    // Extract granted capabilities and behavior from authorization response
    const itemResponse = response.itemResponses[itemId];
    const authData = itemResponse?.data as any;

    if (!authData || !authData.granted) {
      throw new Error(
        "Authorization response missing granted capabilities data",
      );
    }

    // Store the capabilities granted by the user
    this.grantedCapabilities = authData.granted as GrantedCapability[];

    // Store the authorization behavior (mode and expiration)
    const mode = authData.mode || "permissive";
    const duration = authData.duration || 86400000 * 30;
    await this.db.storeAppAuthorizationBehavior(
      this.authorizationManager.appId,
      mode,
      duration,
    );
  }

  async execute(
    executionData: RequestCapabilitiesExecutionData,
  ): Promise<RequestCapabilitiesResult> {
    if (!this.grantedCapabilities) {
      throw new Error("No capabilities were granted during authorization");
    }

    // Translate granted capabilities to persistent authorization storage keys
    await this.db.storeCapabilityGrants(
      this.authorizationManager.appId,
      this.grantedCapabilities,
    );

    await this.emitProgress("SUCCESS", undefined, true);

    // Return WalletCapabilities response (no expiresAt - that's wallet-internal)
    return {
      version: "1.0" as typeof CAPABILITY_VERSION,
      granted: this.grantedCapabilities,
      wallet: {
        name: "Demo Wallet",
        version: "1.0.0",
      },
    };
  }
}
