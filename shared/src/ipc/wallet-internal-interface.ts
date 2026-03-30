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
import type {
  AuthorizationRequest,
  AuthorizationResponse,
} from "../wallet/types/authorization";
import type { InternalAccount } from "../wallet/core/internal-wallet";
import type { DecodedExecutionTrace } from "../wallet/decoding/tx-callstack-decoder";

export type OnWalletUpdateListener = (
  interaction: WalletInteraction<any>
) => void;
export type OnAuthorizationRequestListener = (
  request: AuthorizationRequest
) => void;
export type OnProofDebugExportRequestListener = (
  request: ProofDebugExportRequest
) => void;

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
    nestedEvents: z.array(
      z.union([PrivateCallEventSchema, PublicCallEventSchema])
    ),
  })
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
  oracles: z.record(z.object({ times: z.array(z.number()) })).optional(),
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
      perMethod: z.record(z.object({ times: z.array(z.number()) })),
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
    signingKey: Buffer
  ): Promise<void>;
  deployAccount(address: AztecAddress): Promise<void>;
  getAccounts(): Promise<InternalAccount[]>; // Override with enriched type
  getInteractions(): Promise<WalletInteraction<WalletInteractionType>[]>;
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
  onProofDebugExportRequest: (
    callback: OnProofDebugExportRequestListener
  ) => void;
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
    requestedCapabilities?: GrantedCapability[]
  ): Promise<void>;
  revokeCapability(
    appId: string,
    capability: GrantedCapability
  ): Promise<void>;
  updateAccountAuthorization(
    appId: string,
    accounts: { alias: string; item: string }[]
  ): Promise<void>;
  updateAddressBookAuthorization(
    appId: string,
    contacts: { alias: string; item: string }[]
  ): Promise<void>;
  revokeAuthorization(key: string): Promise<void>;
  revokeAppAuthorizations(appId: string): Promise<void>;
};

export const InternalWalletInterfaceSchema: ApiSchemaFor<InternalWalletInterface> =
  {
    ...WalletSchema,
    // @ts-ignore Annoying zod error
    createAccount: z
      .function()
      .args(
        z.string(),
        z.enum(AccountTypes),
        schemas.Fr,
        schemas.Fr,
        schemas.Buffer
      ),
    // @ts-ignore Annoying zod error
    deployAccount: z
      .function()
      .args(schemas.AztecAddress),
    // @ts-ignore - Type inference for enriched InternalAccount with type field
    getAccounts: z
      .function()
      .args()
      .returns(
        z.array(
          z.object({
            alias: z.string(),
            item: schemas.AztecAddress,
            type: z.enum(AccountTypes),
            deployed: z.boolean(),
          })
        )
      ),
    getInteractions: z
      .function()
      .args()
      .returns(z.array(WalletInteractionSchema)),
    // @ts-ignore
    getExecutionTrace: z
      .function()
      .args(z.string())
      .returns(
        optional(
          z.object({
            trace: DecodedExecutionTraceSchema.optional(),
            stats: ExecutionStatsSchema.optional(),
            from: z.string().optional(),
            embeddedPaymentMethodFeePayer: z.string().optional(),
          })
        )
      ),
    // @ts-ignore
    resolveAuthorization: z.function().args(
      z.object({
        id: z.string(),
        approved: z.boolean(),
        appId: z.string(),
        itemResponses: z.record(z.any()),
      })
    ),
    // App authorization management
    listAuthorizedApps: z.function().args().returns(z.array(z.string())),
    // @ts-ignore
    getAppCapabilities: z
      .function()
      .args(z.string())
      .returns(
        z.object({
          requested: z.array(z.any()),
          granted: z.array(z.any()),
        }),
      ),
    // @ts-ignore
    resolveContractNames: z
      .function()
      .args(z.array(z.string()))
      .returns(z.record(z.string())),
    // @ts-ignore
    capabilityToStorageKeys: z
      .function()
      .args(z.any())
      .returns(z.array(z.string())),
    // @ts-ignore
    storeCapabilityGrants: z
      .function()
      .args(z.string(), z.array(z.any()), z.array(z.any()).optional())
      .returns(z.void()),
    // @ts-ignore
    revokeCapability: z
      .function()
      .args(z.string(), z.any())
      .returns(z.void()),
    // @ts-ignore
    updateAccountAuthorization: z
      .function()
      .args(
        z.string(),
        z.array(z.object({ alias: z.string(), item: z.string() })),
      ),
    // @ts-ignore
    updateAddressBookAuthorization: z
      .function()
      .args(
        z.string(),
        z.array(z.object({ alias: z.string(), item: z.string() })),
      ),
    // @ts-ignore
    revokeAuthorization: z.function().args(z.string()),
    // @ts-ignore
    revokeAppAuthorizations: z.function().args(z.string()),
  };
