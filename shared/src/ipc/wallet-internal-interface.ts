import { Fr } from "@aztec/aztec.js/fields";
import type { AztecAddress } from "@aztec/aztec.js/addresses";
import { type Wallet, WalletSchema, type GrantedCapability } from "@aztec/aztec.js/wallet";
import { optional, schemas } from "@aztec/stdlib/schemas";
import { z } from "zod";
import { type ApiSchemaFor } from "@aztec/stdlib/schemas";
import { AccountTypes, type AccountType } from "../wallet/database/wallet-db";
import type {
  ProofDebugExportRequest,
  WalletInteraction,
  WalletInteractionType,
} from "../wallet/types/wallet-interaction";
import { WalletInteractionSchema } from "../wallet/types/wallet-interaction";
import type { AuthorizationRequest, AuthorizationResponse } from "../wallet/types/authorization";
import type { InternalAccount } from "../wallet/core/internal-wallet";
import type { DecodedExecutionTrace } from "../wallet/decoding/tx-callstack-decoder";
import type { HandshakeRelayRequest, HandshakeRelayResponse } from "../wallet/types/handshake";

export type OnWalletUpdateListener = (interaction: WalletInteraction<any>) => void;
export type OnAuthorizationRequestListener = (request: AuthorizationRequest) => void;
export type OnProofDebugExportRequestListener = (request: ProofDebugExportRequest) => void;
export type OnHandshakeRelayRequestListener = (request: HandshakeRelayRequest) => void;

// Zod schema for execution trace components
const ContractInfoSchema = z.object({
  name: z.string(),
  address: z.string(),
});

const ArgValueSchema = z.object({
  name: z.string(),
  value: z.string(),
});

const PublicCallEventSchema: z.ZodType<any> = z.object({
  type: z.literal("public-call"),
  depth: z.number(),
  counter: z.number(),
  contract: ContractInfoSchema,
  function: z.string(),
  caller: ContractInfoSchema,
  isStaticCall: z.boolean(),
  args: z.array(ArgValueSchema),
  returnValues: z.array(ArgValueSchema).optional(),
});

const PrivateCallEventSchema: z.ZodType<any> = z.lazy(() =>
  z.object({
    type: z.literal("private-call"),
    depth: z.number(),
    counter: z.object({
      start: z.number(),
      end: z.number(),
    }),
    contract: ContractInfoSchema,
    function: z.string(),
    caller: ContractInfoSchema,
    isStaticCall: z.boolean(),
    args: z.array(ArgValueSchema),
    returnValues: z.array(ArgValueSchema),
    nestedEvents: z.array(z.union([PrivateCallEventSchema, PublicCallEventSchema])),
  }),
);

const DecodedExecutionTraceSchema = z.union([
  // Full transaction trace
  z.object({
    privateExecution: PrivateCallEventSchema,
    publicCalls: z.array(PublicCallEventSchema),
  }),
  // Simplified utility trace
  z.object({
    functionName: z.string(),
    args: z.any(),
    contractAddress: z.string(),
    contractName: z.string(),
    result: z.any(),
    isUtility: z.literal(true),
  }),
]);

// Schemas for simulation/proving stats
const FunctionTimingSchema = z.object({
  functionName: z.string(),
  time: z.number(),
  oracles: z.record(z.string(), z.object({ times: z.array(z.number()) })).optional(),
});

const StatsTimingsSchema = z.object({
  sync: z.number(),
  publicSimulation: z.number().optional(),
  validation: z.number().optional(),
  proving: z.number().optional(),
  perFunction: z.array(FunctionTimingSchema),
  unaccounted: z.number(),
  total: z.number(),
  // Wall-clock phases injected at origin
  simulation: z.number().optional(),
  sending: z.number().optional(),
  mining: z.number().optional(),
});

const ExecutionStatsSchema = z.object({
  timings: StatsTimingsSchema,
  nodeRPCCalls: z
    .object({
      perMethod: z.record(z.string(), z.object({ times: z.array(z.number()) })),
      roundTrips: z.object({
        roundTripDurations: z.array(z.number()),
        roundTripMethods: z.array(z.array(z.string())),
      }),
    })
    .optional(),
});

// Internal wallet interface - extends external with internal-only methods
export type InternalWalletInterface = Omit<Wallet, "getAccounts"> & {
  createAccount(
    alias: string,
    type: AccountType,
    secret: Fr,
    salt: Fr,
    signingKey: Buffer,
  ): Promise<void>;
  deployAccount(address: AztecAddress): Promise<void>;
  getAccounts(): Promise<InternalAccount[]>; // Override with enriched type
  getInteractions(): Promise<WalletInteraction<WalletInteractionType>[]>;
  deleteInteraction(id: string): Promise<void>;
  clearInteractions(): Promise<void>;
  getExecutionTrace(interactionId: string): Promise<
    | {
        trace?: DecodedExecutionTrace;
        stats?: z.infer<typeof ExecutionStatsSchema>;
        from?: string;
        embeddedPaymentMethodFeePayer?: string;
      }
    | undefined
  >;
  resolveAuthorization(response: AuthorizationResponse): void;
  onWalletUpdate(callback: OnWalletUpdateListener): () => void;
  onAuthorizationRequest(callback: OnAuthorizationRequestListener): () => void;
  onProofDebugExportRequest: (callback: OnProofDebugExportRequestListener) => void;
  // Interactive handshakes (Aztec v5)
  respondToInteractiveHandshake(requestBlob: string): Promise<string>;
  resolveHandshakeRelay(response: HandshakeRelayResponse): void;
  setSenderPrivateChannel(address: AztecAddress, enabled: boolean): Promise<void>;
  getSenderPrivateChannels(): Promise<Record<string, boolean>>;
  onHandshakeRelayRequest(callback: OnHandshakeRelayRequestListener): () => void;
  // App authorization management
  listAuthorizedApps(): Promise<string[]>;
  getAppCapabilities(appId: string): Promise<{
    requested: GrantedCapability[];
    granted: GrantedCapability[];
  }>;
  resolveContractNames(addresses: string[]): Promise<Record<string, string>>;
  capabilityToStorageKeys(capability: GrantedCapability): Promise<string[]>;
  storeCapabilityGrants(
    appId: string,
    granted: GrantedCapability[],
    requestedCapabilities?: GrantedCapability[],
  ): Promise<void>;
  revokeCapability(appId: string, capability: GrantedCapability): Promise<void>;
  updateAccountAuthorization(
    appId: string,
    accounts: { alias: string; item: string }[],
  ): Promise<void>;
  updateAddressBookAuthorization(
    appId: string,
    contacts: { alias: string; item: string }[],
  ): Promise<void>;
  revokeAuthorization(key: string): Promise<void>;
  revokeAppAuthorizations(appId: string): Promise<void>;
};

export const InternalWalletInterfaceSchema: ApiSchemaFor<InternalWalletInterface> = {
  ...WalletSchema,
  createAccount: z.function({
    input: z.tuple([z.string(), z.enum(AccountTypes), schemas.Fr, schemas.Fr, schemas.Buffer]),
    output: z.void(),
  }),
  deployAccount: z.function({ input: z.tuple([schemas.AztecAddress]), output: z.void() }),
  getAccounts: z.function({
    input: z.tuple([]),
    output: z.array(
      z.object({
        alias: z.string(),
        item: schemas.AztecAddress,
        type: z.enum(AccountTypes),
        deployed: z.boolean(),
      }),
    ),
  }),
  getInteractions: z.function({ input: z.tuple([]), output: z.array(WalletInteractionSchema) }),
  deleteInteraction: z.function({ input: z.tuple([z.string()]), output: z.void() }),
  clearInteractions: z.function({ input: z.tuple([]), output: z.void() }),
  // @ts-expect-error - zod type inference for the optional union return type
  getExecutionTrace: z.function({
    input: z.tuple([z.string()]),
    output: optional(
      z.object({
        trace: DecodedExecutionTraceSchema.optional(),
        stats: ExecutionStatsSchema.optional(),
        from: z.string().optional(),
        embeddedPaymentMethodFeePayer: z.string().optional(),
      }),
    ),
  }),
  // @ts-expect-error - zod type inference for the itemResponses record
  resolveAuthorization: z.function({
    input: z.tuple([
      z.object({
        id: z.string(),
        approved: z.boolean(),
        appId: z.string(),
        itemResponses: z.record(z.string(), z.any()),
      }),
    ]),
    output: z.void(),
  }),
  // Interactive handshakes (Aztec v5)
  respondToInteractiveHandshake: z.function({
    input: z.tuple([z.string()]),
    output: z.string(),
  }),
  resolveHandshakeRelay: z.function({
    input: z.tuple([
      z.object({
        id: z.string(),
        approved: z.boolean(),
        signatureBlob: z.string().optional(),
      }),
    ]),
    output: z.void(),
  }),
  setSenderPrivateChannel: z.function({
    input: z.tuple([schemas.AztecAddress, z.boolean()]),
    output: z.void(),
  }),
  getSenderPrivateChannels: z.function({
    input: z.tuple([]),
    output: z.record(z.string(), z.boolean()),
  }),
  // App authorization management
  listAuthorizedApps: z.function({ input: z.tuple([]), output: z.array(z.string()) }),
  getAppCapabilities: z.function({
    input: z.tuple([z.string()]),
    output: z.object({
      requested: z.array(z.any()),
      granted: z.array(z.any()),
    }),
  }),
  resolveContractNames: z.function({
    input: z.tuple([z.array(z.string())]),
    output: z.record(z.string(), z.string()),
  }),
  capabilityToStorageKeys: z.function({
    input: z.tuple([z.any()]),
    output: z.array(z.string()),
  }),
  storeCapabilityGrants: z.function({
    input: z.tuple([z.string(), z.array(z.any()), z.array(z.any()).optional()]),
    output: z.void(),
  }),
  revokeCapability: z.function({ input: z.tuple([z.string(), z.any()]), output: z.void() }),
  updateAccountAuthorization: z.function({
    input: z.tuple([z.string(), z.array(z.object({ alias: z.string(), item: z.string() }))]),
    output: z.void(),
  }),
  updateAddressBookAuthorization: z.function({
    input: z.tuple([z.string(), z.array(z.object({ alias: z.string(), item: z.string() }))]),
    output: z.void(),
  }),
  revokeAuthorization: z.function({ input: z.tuple([z.string()]), output: z.void() }),
  revokeAppAuthorizations: z.function({ input: z.tuple([z.string()]), output: z.void() }),
};
