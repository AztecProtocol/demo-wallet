import { Fr } from "@aztec/aztec.js/fields";
import { type Wallet, WalletSchema } from "@aztec/aztec.js/wallet";
import { optional, schemas } from "@aztec/stdlib/schemas";
import { z } from "zod";
import { type ApiSchemaFor } from "@aztec/stdlib/schemas";
import { AccountTypes, type AccountType } from "../wallet/database/wallet-db";
import type {
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

type OnWalletUpdateListener = (interaction: WalletInteraction<any>) => void;
type OnAuthorizationRequestListener = (request: AuthorizationRequest) => void;

// Zod schema for execution trace components
const ContractInfoSchema = z.object({
  name: z.string(),
  address: z.string(),
});

const ArgValueSchema = z.object({
  name: z.string(),
  value: z.string(),
});

const PublicEnqueueEventSchema: z.ZodType<any> = z.object({
  type: z.literal("public-enqueue"),
  depth: z.number(),
  counter: z.number(),
  contract: ContractInfoSchema,
  function: z.string(),
  caller: ContractInfoSchema,
  isStaticCall: z.boolean(),
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
      z.union([PrivateCallEventSchema, PublicEnqueueEventSchema])
    ),
  })
);

const DecodedExecutionTraceSchema = z.union([
  // Full transaction trace
  z.object({
    privateExecution: PrivateCallEventSchema,
    publicExecutionQueue: z.array(PublicEnqueueEventSchema),
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

// Internal wallet interface - extends external with internal-only methods
export type InternalWalletInterface = Omit<Wallet, "getAccounts"> & {
  createAccount(
    alias: string,
    type: AccountType,
    secret: Fr,
    salt: Fr,
    signingKey: Buffer
  ): Promise<void>;
  getAccounts(): Promise<InternalAccount[]>; // Override with enriched type
  getInteractions(): Promise<WalletInteraction<WalletInteractionType>[]>;
  getExecutionTrace(interactionId: string): Promise<
    | {
        trace?: DecodedExecutionTrace;
        stats?: any;
        from?: string;
        embeddedPaymentMethodFeePayer?: string;
      }
    | undefined
  >;
  resolveAuthorization(response: AuthorizationResponse): void;
  onWalletUpdate(callback: OnWalletUpdateListener): void;
  onAuthorizationRequest(callback: OnAuthorizationRequestListener): void;
  // App authorization management
  listAuthorizedApps(): Promise<string[]>;
  getAppAuthorizations(appId: string): Promise<{
    accounts: { alias: string; item: string }[];
    simulations: Array<{
      type: "simulateTx" | "simulateUtility";
      payloadHash: string;
      title?: string;
      key: string;
    }>;
    otherMethods: string[];
  }>;
  updateAccountAuthorization(
    appId: string,
    accounts: { alias: string; item: string }[]
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
            stats: z.any().optional(),
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
    getAppAuthorizations: z
      .function()
      .args(z.string())
      .returns(
        z.object({
          accounts: z.array(z.object({ alias: z.string(), item: z.string() })),
          simulations: z.array(
            z.object({
              type: z.enum(["simulateTx", "simulateUtility"]),
              payloadHash: z.string(),
              title: z.string().optional(),
              key: z.string(),
            })
          ),
          otherMethods: z.array(z.string()),
        })
      ),
    // @ts-ignore
    updateAccountAuthorization: z
      .function()
      .args(
        z.string(),
        z.array(z.object({ alias: z.string(), item: z.string() }))
      ),
    // @ts-ignore
    revokeAuthorization: z.function().args(z.string()),
    // @ts-ignore
    revokeAppAuthorizations: z.function().args(z.string()),
  };
