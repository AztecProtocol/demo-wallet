import type { Capability, ContractFunctionPattern } from "@aztec/aztec.js/wallet";
import type { AztecAddress } from "@aztec/aztec.js/addresses";
import React from "react";
import { CheckCircle, Lock, Storage, PlayArrow, Send, DataObject, Code } from "@mui/icons-material";

// Helper to format contract address
export function formatContractAddress(
  address: AztecAddress | string,
  metadata: Map<string, string>,
): string {
  const addressStr = address.toString();
  const name = metadata.get(addressStr);
  const shortAddr = `${addressStr.slice(0, 10)}...${addressStr.slice(-8)}`;
  return name ? `${name} (${shortAddr})` : shortAddr;
}

// Helper to get icon for capability type (returns JSX element)
export function getCapabilityIcon(type: Capability["type"]) {
  switch (type) {
    case "accounts":
      return <CheckCircle />;
    case "contracts":
      return <Storage />;
    case "contractClasses":
      return <Code />;
    case "simulation":
      return <PlayArrow />;
    case "transaction":
      return <Send />;
    case "data":
      return <DataObject />;
    default:
      return <Lock />;
  }
}

// Helper to get human-readable label for capability type
export function getCapabilityTypeName(type: Capability["type"], compact?: boolean): string {
  switch (type) {
    case "accounts":
      return "Account Access";
    case "contracts":
      return compact ? "Contracts" : "Contract Operations";
    case "contractClasses":
      return compact ? "Contract Classes" : "Contract Class Metadata";
    case "simulation":
      return compact ? "Simulation" : "Transaction & Utility Simulation";
    case "transaction":
      return compact ? "Transactions" : "Transaction Execution";
    case "data":
      return "Data Access";
    default:
      return "Unknown";
  }
}

// Group patterns by contract for simulation/transaction
export function groupPatternsByContract(
  patterns: ContractFunctionPattern[],
): Map<string, Set<number>> {
  const grouped = new Map<string, Set<number>>();
  patterns.forEach((pattern, idx) => {
    const key = pattern.contract === "*" ? "*" : pattern.contract.toString();
    if (!grouped.has(key)) {
      grouped.set(key, new Set());
    }
    grouped.get(key)!.add(idx);
  });
  return grouped;
}
