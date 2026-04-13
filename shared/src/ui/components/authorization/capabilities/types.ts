import type { Capability } from "@aztec/aztec.js/wallet";
import type { Aliased } from "@aztec/aztec.js/wallet";
import type { AztecAddress } from "@aztec/aztec.js/addresses";

// Extract specific capability types from the Capability union
export type AccountsCapability = Extract<Capability, { type: "accounts" }>;
export type ContractsCapability = Extract<Capability, { type: "contracts" }>;
export type ContractClassesCapability = Extract<Capability, { type: "contractClasses" }>;
export type SimulationCapability = Extract<Capability, { type: "simulation" }>;
export type TransactionCapability = Extract<Capability, { type: "transaction" }>;
export type DataCapability = Extract<Capability, { type: "data" }>;

// GrantedCapability types
export type GrantedAccountsCapability = AccountsCapability & {
  accounts: Aliased<AztecAddress>[];
};

export type GrantedCapability =
  | GrantedAccountsCapability
  | ContractsCapability
  | ContractClassesCapability
  | SimulationCapability
  | TransactionCapability
  | DataCapability;

export type AccountSelection = {
  address: string;
  alias: string;
  originalAlias: string;
  selected: boolean;
};

export type CheckState = {
  checked: boolean;
  indeterminate: boolean;
};
