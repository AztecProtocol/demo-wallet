import type {
  AuthorizationRequest,
  AuthorizationResponse,
  AuthorizationItem,
  AuthorizationItemResponse,
} from "../types/authorization";
import { AuthorizationRequestEvent } from "../types/authorization";
import {
  promiseWithResolvers,
  type PromiseWithResolvers,
} from "@aztec/foundation/promise";
import type { WalletDB } from "../database/wallet-db";

/**
 * Manages authorization requests from operations.
 *
 * This manager encapsulates the logic for creating authorization requests,
 * dispatching events, and waiting for user responses, providing a clean
 * interface for operations to request user permission.
 *
 * Supports persistent authorization for operations that need to cache user permissions.
 */
export class AuthorizationManager {
  constructor(
    public readonly appId: string,
    private db: WalletDB,
    private pendingAuthorizations: Map<
      string,
      {
        promise: PromiseWithResolvers<AuthorizationResponse>;
        request: AuthorizationRequest;
      }
    >,
    private eventEmitter: EventTarget,
  ) {}

  /**
   * Request authorization for one or more operations.
   * Checks for existing persistent authorizations first and only requests new ones.
   *
   * @param items - Array of authorization items (with optional persistence config)
   * @returns Authorization response with approved items
   */
  async requestAuthorization(
    items: AuthorizationItem[],
  ): Promise<AuthorizationResponse> {
    // Check for existing persistent authorizations
    const itemsNeedingAuth: AuthorizationItem[] = [];
    const autoApprovedItems: Record<string, AuthorizationItemResponse> = {};

    for (const item of items) {
      if (item.persistence) {
        // Handle single key or multiple keys (for batch operations like simulateTx)
        const keys = Array.isArray(item.persistence.storageKey)
          ? item.persistence.storageKey
          : [item.persistence.storageKey];

        // Check if ALL keys have existing authorization (for multi-key operations)
        let allAuthorized = true;
        let existingAuth: any | undefined = undefined;

        for (const key of keys) {
          // Try exact match first
          let auth = await this.db.retrievePersistentAuthorization(
            this.appId,
            key,
          );

          // If no exact match, try wildcard patterns
          if (auth === undefined) {
            auth = await this.checkWildcardAuthorization(key);
          }

          // If any key is not authorized, need user approval
          if (auth === undefined) {
            allAuthorized = false;
            break;
          }

          // Store first authorization data found (they should all be the same type)
          if (existingAuth === undefined) {
            existingAuth = auth;
          }
        }

        if (allAuthorized && existingAuth !== undefined) {
          // Auto-approve this item
          autoApprovedItems[item.id] = {
            id: item.id,
            approved: true,
            appId: this.appId,
            data: existingAuth,
          };
          continue;
        }
      }

      // No existing auth, needs user approval
      itemsNeedingAuth.push(item);
    }

    // If all items were auto-approved, return immediately
    if (itemsNeedingAuth.length === 0) {
      return {
        id: crypto.randomUUID(),
        approved: true,
        appId: this.appId,
        itemResponses: autoApprovedItems,
      };
    }

    // Check if app is in strict mode
    const behavior = await this.db.getAppAuthorizationBehavior(this.appId);
    if (behavior?.mode === "strict") {
      // In strict mode, reject any requests that don't have explicit authorization
      // EXCEPT for meta-operations that should always be allowed
      const ALWAYS_ALLOWED_METHODS = new Set(["requestCapabilities"]);

      const unauthorizedItems = itemsNeedingAuth.filter(
        (item) => !ALWAYS_ALLOWED_METHODS.has(item.method),
      );

      if (unauthorizedItems.length > 0) {
        throw new Error(
          "Authorization denied: app is in strict mode and this operation is not authorized",
        );
      }
    }

    // Request authorization for remaining items (permissive mode)
    const authRequest: AuthorizationRequest = {
      id: crypto.randomUUID(),
      appId: this.appId,
      items: itemsNeedingAuth,
      timestamp: Date.now(),
    };

    const responseHandle = promiseWithResolvers<AuthorizationResponse>();
    this.pendingAuthorizations.set(authRequest.id, {
      promise: responseHandle,
      request: authRequest,
    });

    const event = new AuthorizationRequestEvent(authRequest);
    this.eventEmitter.dispatchEvent(event);

    const response = await responseHandle.promise;

    if (!response.approved) {
      throw new Error("User denied batch request");
    }

    // Store persistent authorizations for newly approved items
    for (const item of itemsNeedingAuth) {
      const itemResponse = response.itemResponses[item.id];

      if (itemResponse?.approved && item.persistence) {
        // Use persistData from config if provided, otherwise use response data
        const dataToStore =
          item.persistence.persistData !== undefined
            ? item.persistence.persistData
            : itemResponse.data;

        // Handle single key or multiple keys (for batch operations like simulateTx)
        const keys = Array.isArray(item.persistence.storageKey)
          ? item.persistence.storageKey
          : [item.persistence.storageKey];

        // Store authorization for each key
        for (const key of keys) {
          await this.db.storePersistentAuthorization(
            this.appId,
            key,
            dataToStore,
          );
        }
      }
    }

    // Merge auto-approved items with newly approved items
    return {
      ...response,
      itemResponses: {
        ...autoApprovedItems,
        ...response.itemResponses,
      },
    };
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
    const pending = this.pendingAuthorizations.get(response.id);
    if (pending) {
      pending.promise.resolve(response);
      this.pendingAuthorizations.delete(response.id);
    }
  }

  /**
   * Check for wildcard authorization patterns that match the requested storage key.
   *
   * Tries progressively broader patterns:
   * - "registerContract:0x123..." → check "registerContract:*"
   * - "simulateTx:0x123...:swap" → check "simulateTx:0x123...:*" → check "simulateTx:*"
   * - "sendTx:0x123...:swap" → check "sendTx:0x123...:*" → check "sendTx:*"
   *
   * @param storageKey - Storage key to check for wildcard matches
   * @returns Existing authorization data if wildcard match found, undefined otherwise
   */
  private async checkWildcardAuthorization(
    storageKey: string,
  ): Promise<any | undefined> {
    const parts = storageKey.split(":");
    if (parts.length === 1) {
      // No pattern to match (simple method like "getAccounts")
      return undefined;
    }

    const method = parts[0];
    const remaining = parts.slice(1);

    // Try progressively broader wildcards
    // For "method:contract:function", try:
    // 1. "method:contract:*"
    // 2. "method:*"

    if (remaining.length === 2) {
      // Try contract-specific wildcard: "method:contract:*"
      const contractWildcard = `${method}:${remaining[0]}:*`;
      const auth = await this.db.retrievePersistentAuthorization(
        this.appId,
        contractWildcard,
      );
      if (auth !== undefined) {
        return auth;
      }
    }

    // Try full wildcard: "method:*"
    const fullWildcard = `${method}:*`;
    return await this.db.retrievePersistentAuthorization(
      this.appId,
      fullWildcard,
    );
  }
}
