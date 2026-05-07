import type { ChainInfo } from "@aztec/aztec.js/account";
import { Fr } from "@aztec/aztec.js/fields";
import {
  ExecutionPayloadSchema,
  ProfileOptionsSchema,
  SendOptionsSchema,
  SimulateOptionsSchema,
  WalletSchema,
} from "@aztec/aztec.js/wallet";
import { schemas } from "@aztec/stdlib/schemas";
import { z } from "zod";

/**
 * Build an args parser from a Zod-function schema. Returns a function that
 * pads the incoming args with `undefined` up to the schema's tuple length
 * before parsing — needed because `z.function().args(a, b, c.optional())`
 * compiles to a tuple of fixed length 3 even though the third slot is
 * optional. Without padding, callers passing 2 args trip a "min 3" error.
 */
function makeArgsParser(
  methodSchema: unknown,
): ((args: unknown[]) => unknown[]) | undefined {
  if (!methodSchema || typeof methodSchema !== "object" || !("_def" in methodSchema)) {
    return undefined;
  }
  const def = (methodSchema as { _def: { args?: unknown } })._def;
  const argsSchema = def.args as
    | { parse: (a: unknown[]) => unknown[]; _def?: { items?: unknown[] } }
    | undefined;
  if (!argsSchema || typeof argsSchema.parse !== "function") return undefined;
  const expectedLen = argsSchema._def?.items?.length ?? 0;
  return (args: unknown[]) => {
    const padded = args.length < expectedLen
      ? [...args, ...Array(expectedLen - args.length).fill(undefined)]
      : args;
    return argsSchema.parse(padded);
  };
}

/**
 * Upstream `aztec.js`'s `SendOptionsSchema` / `SimulateOptionsSchema` /
 * `ProfileOptionsSchema` are missing `sendMessagesAs`, even though the
 * TypeScript type (`SendInteractionOptions`) declares it. Zod's default
 * `z.object` strips unknown keys — so when a dApp passes
 * `.send({ from: NO_FROM, sendMessagesAs: userAddr, ... })` (the standard
 * pattern for FPC-sponsored / account-deployment flows), `sendMessagesAs`
 * silently disappears at our offscreen wallet's argsParser. The downstream
 * PXE then sees `senderForTags === undefined` and any private-log emission
 * inside the contract trips `Sender for tags is not set`.
 *
 * Patch: extend the option schemas with `sendMessagesAs: optional(AztecAddress)`
 * so the field is preserved AND revived back into an `AztecAddress` instance
 * (raw hex strings can't be `.toField()`'d by the oracle).
 *
 * The replacement `z.function()` schemas are slot-in compatible with the
 * upstream entries — same args order, same return types — so callers see
 * no change. They're substituted into a copy of `WalletSchema` below.
 */
const PatchedSendOptionsSchema = SendOptionsSchema.extend({
  sendMessagesAs: schemas.AztecAddress.optional(),
});
const PatchedSimulateOptionsSchema = SimulateOptionsSchema.extend({
  sendMessagesAs: schemas.AztecAddress.optional(),
});
const PatchedProfileOptionsSchema = ProfileOptionsSchema.extend({
  sendMessagesAs: schemas.AztecAddress.optional(),
});

// We only need the return-type ZodSchema from the upstream entry — pull it
// off as `unknown` and re-cast to the broadest Zod type to avoid pinning
// ourselves to upstream's deeply-generic `ZodFunction` shape.
const upstreamReturn = (name: string): z.ZodTypeAny =>
  (
    (WalletSchema as Record<string, { returnType: () => z.ZodTypeAny }>)[name]
  ).returnType();

const PatchedSimulateTxSchema = z
  .function()
  .args(ExecutionPayloadSchema, PatchedSimulateOptionsSchema)
  .returns(upstreamReturn("simulateTx"));

const PatchedSendTxSchema = z
  .function()
  .args(ExecutionPayloadSchema, PatchedSendOptionsSchema)
  .returns(upstreamReturn("sendTx"));

const PatchedProfileTxSchema = z
  .function()
  .args(ExecutionPayloadSchema, PatchedProfileOptionsSchema)
  .returns(upstreamReturn("profileTx"));

const PatchedWalletSchema: Record<string, unknown> = {
  ...WalletSchema,
  simulateTx: PatchedSimulateTxSchema,
  sendTx: PatchedSendTxSchema,
  profileTx: PatchedProfileTxSchema,
};

/**
 * Coerce a `chainInfo`-shaped value back into one with `Fr` instances after
 * it's crossed a JSON-serializing port boundary (where Fr → hex string). Same
 * tolerant narrowing as the rollup-version case in shared session.ts.
 */
function reviveChainInfo(raw: unknown): ChainInfo {
  const r = raw as { chainId: unknown; version: unknown };
  const toFr = (v: unknown): Fr =>
    v instanceof Fr
      ? v
      : typeof v === "string"
        ? Fr.fromString(v)
        : new Fr(v as bigint | number | boolean);
  return { chainId: toFr(r.chainId), version: toFr(r.version) };
}
import {
  getOrCreateSession,
  getRunningSessionIds,
  getSharedResources,
  InternalWalletInterfaceSchema,
  setStoreFactory,
} from "@demo-wallet/shared/core";
import { VaultState } from "../vault/vault-state";
import { PortServer, type MethodHandlerMap } from "../ipc/port-server";

export class WalletHost {
  private vault = new VaultState();
  private server: PortServer;
  /** Currently selected network (set by UI; defaults to localhost). */
  private currentChainInfo: ChainInfo = { chainId: new Fr(31337), version: new Fr(0) };

  constructor() {
    this.server = new PortServer(this.buildHandlers());
  }

  start() {
    // Route every kv-store opened by shared session code through the vault.
    // The vault holds the in-memory Argon2id key and lazily opens encrypted
    // sqlite-opfs files on demand. If the vault is locked when a session is
    // first created, the factory throws and the error propagates to the
    // caller as "Vault is locked".
    setStoreFactory(async (name) => await this.vault.getStore(name));

    this.server.start();
    this.vault.onChange((state) => {
      if (state === "locked") {
        this.server.broadcast("vault-locked", null);
      } else {
        this.server.broadcast("vault-unlocked", null);
      }
    });
  }

  private buildHandlers(): MethodHandlerMap {
    return {
      "vault.isInitialized": async () => await this.vault.isInitialized(),
      "vault.isUnlocked": async () => this.vault.isUnlocked(),
      "vault.initialize": async (password) =>
        await this.vault.initialize(password as string),
      "vault.unlock": async (password) => await this.vault.unlock(password as string),
      "vault.lock": async () => this.vault.lock(),

      "network.set": async (chainId, version) => {
        this.currentChainInfo = {
          chainId: Fr.fromString(chainId as string),
          version: Fr.fromString(version as string),
        };
      },
      "network.get": async () => ({
        chainId: this.currentChainInfo.chainId.toString(),
        version: this.currentChainInfo.version.toString(),
      }),

      // Returns ALL pending authorization requests across every running
      // session. Pending authorizations live on per-session shared resources,
      // and the dApp call's session (e.g. testnet) may differ from the UI's
      // currentChainInfo (e.g. localhost) — so a single-session lookup misses
      // requests entirely. The approval window only knows the requestId; we
      // give it everything and let it filter.
      "authorization.getPending": async () => {
        const sessionIds = getRunningSessionIds();
        const all = [];
        for (const sessionId of sessionIds) {
          const shared = await getSharedResources(sessionId);
          for (const entry of shared.pendingAuthorizations.values()) {
            all.push(entry.request);
          }
        }
        return all;
      },

      // Resolve an authorization across any session: find the session whose
      // pendingAuthorizations contains the requestId, resolve there.
      // Mirrors AuthorizationManager.resolveAuthorization but operates
      // directly on the shared map so we don't need access to the manager.
      "authorization.resolve": async (responseRaw) => {
        const response = responseRaw as {
          id: string;
          approved: boolean;
          appId: string;
          itemResponses: Record<string, unknown>;
        };
        const sessionIds = getRunningSessionIds();
        for (const sessionId of sessionIds) {
          const shared = await getSharedResources(sessionId);
          const pending = shared.pendingAuthorizations.get(response.id);
          if (pending) {
            pending.promise.resolve(response as never);
            shared.pendingAuthorizations.delete(response.id);
            return true;
          }
        }
        return false;
      },

      ...this.buildWalletMethodHandlers(),
      ...this.buildDappMethodHandlers(),
    };
  }

  private forwardWalletEvent = (eventType: string, detail: unknown) => {
    if (eventType === "wallet-update") {
      this.server.broadcast("wallet-update", detail);
    } else if (eventType === "authorization-request") {
      this.server.broadcast("authorization-request", detail);
    } else if (eventType === "proof-debug-export-request") {
      this.server.broadcast("proof-debug-export-request", detail);
    }
  };

  private buildWalletMethodHandlers(): MethodHandlerMap {
    const guard = async () => {
      if (!this.vault.isUnlocked()) {
        throw new Error("Vault is locked");
      }
      const { internal } = await getOrCreateSession(
        this.currentChainInfo,
        "ui",
        this.forwardWalletEvent,
      );
      return internal;
    };

    const handlers: MethodHandlerMap = {};
    for (const methodName of Object.keys(InternalWalletInterfaceSchema)) {
      // chrome.runtime.Port serializes via JSON across contexts, so Aztec
      // primitives the UI passes (Fr, AztecAddress, Buffer, …) arrive as their
      // toJSON forms (hex strings, plain objects). The Zod schema for each
      // method already knows how to parse those back into class instances —
      // pull the args parser once per method.
      const methodSchema = (
        InternalWalletInterfaceSchema as Record<string, unknown>
      )[methodName];
      const argsParser = makeArgsParser(methodSchema);

      handlers[`wallet.${methodName}`] = async (...args: unknown[]) => {
        const wallet = await guard();
        const fn = (wallet as unknown as Record<string, (...a: unknown[]) => unknown>)[
          methodName
        ];
        if (typeof fn !== "function") {
          throw new Error(`Method ${methodName} not found on InternalWallet`);
        }
        const parsedArgs = argsParser ? argsParser(args) : args;
        return await fn.apply(wallet, parsedArgs);
      };
    }
    return handlers;
  }

  /**
   * Build handlers for `dapp.*` methods. Each forwards to the per-session
   * ExternalWallet identified by `session.appId` + `session.chainInfo`.
   * Called shape: handler(session, message), where message.args is the call payload.
   */
  private buildDappMethodHandlers(): MethodHandlerMap {
    const handlers: MethodHandlerMap = {};
    for (const methodName of Object.keys(PatchedWalletSchema)) {
      // Same JSON-round-trip-revival pattern as wallet.* methods: pull a Zod
      // args parser once per method so primitives (Fr, AztecAddress, ...) get
      // reconstructed from their hex-string forms after the SW→offscreen hop.
      // `PatchedWalletSchema` overrides simulateTx/sendTx/profileTx with
      // option schemas that include `sendMessagesAs` (see comment near the
      // patch definition above for why).
      const methodSchema = PatchedWalletSchema[methodName];
      const argsParser = makeArgsParser(methodSchema);

      handlers[`dapp.${methodName}`] = async (...callArgs: unknown[]) => {
        if (!this.vault.isUnlocked()) {
          throw new Error("Vault is locked");
        }
        const [session, message] = callArgs;
        const sess = session as { appId: string; chainInfo: unknown };
        const msg = message as { args?: unknown[] };

        // Session crossed the port as JSON; chainInfo's Fr instances are now
        // hex strings. Revive them so getOrCreateSession's .toNumber() works.
        const chainInfo = reviveChainInfo(sess.chainInfo);

        const { external } = await getOrCreateSession(
          chainInfo,
          sess.appId,
          this.forwardWalletEvent,
        );
        const rawArgs = msg.args ?? [];
        const args = argsParser ? argsParser(rawArgs) : rawArgs;
        const fn = (external as unknown as Record<string, (...a: unknown[]) => unknown>)[
          methodName
        ];
        if (typeof fn !== "function") {
          throw new Error(`Method ${methodName} not found on ExternalWallet`);
        }
        return await fn.apply(external, args);
      };
    }
    return handlers;
  }
}
