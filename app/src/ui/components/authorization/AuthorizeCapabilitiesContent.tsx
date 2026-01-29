import { useContext, useEffect, useState, useCallback, useMemo } from "react";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import List from "@mui/material/List";
import Chip from "@mui/material/Chip";
import Checkbox from "@mui/material/Checkbox";
import FormControlLabel from "@mui/material/FormControlLabel";
import Accordion from "@mui/material/Accordion";
import AccordionSummary from "@mui/material/AccordionSummary";
import AccordionDetails from "@mui/material/AccordionDetails";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import TextField from "@mui/material/TextField";
import Switch from "@mui/material/Switch";
import {
  CheckCircle,
  Lock,
  Storage,
  PlayArrow,
  Send,
  DataObject,
  Code,
} from "@mui/icons-material";
import type { AuthorizationItem } from "../../../wallet/types/authorization";
import type {
  AppCapabilities,
  Capability,
  ContractFunctionPattern,
} from "@aztec/aztec.js/wallet";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import type { Aliased } from "@aztec/aztec.js/wallet";
import { WalletContext } from "../../renderer";
import type { InternalAccount } from "../../../wallet/core/internal-wallet";

// Extract specific capability types from the Capability union
type AccountsCapability = Extract<Capability, { type: "accounts" }>;
type ContractsCapability = Extract<Capability, { type: "contracts" }>;
type ContractClassesCapability = Extract<Capability, { type: "contractClasses" }>;
type SimulationCapability = Extract<Capability, { type: "simulation" }>;
type TransactionCapability = Extract<Capability, { type: "transaction" }>;
type DataCapability = Extract<Capability, { type: "data" }>;

// GrantedCapability types
type GrantedAccountsCapability = AccountsCapability & {
  accounts: Aliased<AztecAddress>[];
};

type GrantedCapability =
  | GrantedAccountsCapability
  | ContractsCapability
  | ContractClassesCapability
  | SimulationCapability
  | TransactionCapability
  | DataCapability;

interface AuthorizeCapabilitiesContentProps {
  request: AuthorizationItem;
  onCapabilitiesChange?: (data: {
    granted: GrantedCapability[];
    // Wallet-internal settings (not sent to app)
    mode: "strict" | "permissive";
    duration: number;
  }) => void;
  showAppId?: boolean;
}

type AccountSelection = {
  address: string;
  alias: string;
  originalAlias: string;
  selected: boolean;
  allowAuthWit: boolean;
};

// Helper to format contract address
function formatContractAddress(
  address: AztecAddress | string,
  metadata: Map<string, string>
): string {
  const addressStr = address.toString();
  const name = metadata.get(addressStr);
  const shortAddr = `${addressStr.slice(0, 10)}...${addressStr.slice(-8)}`;
  return name ? `${name} (${shortAddr})` : shortAddr;
}

// Helper to get icon for capability type
function getCapabilityIcon(type: Capability["type"]) {
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

// Helper to get display name for capability type
function getCapabilityTypeName(type: Capability["type"]): string {
  switch (type) {
    case "accounts":
      return "Account Access";
    case "contracts":
      return "Contract Operations";
    case "contractClasses":
      return "Contract Class Metadata";
    case "simulation":
      return "Transaction & Utility Simulation";
    case "transaction":
      return "Transaction Execution";
    case "data":
      return "Data Access";
    default:
      return "Unknown";
  }
}

export function AuthorizeCapabilitiesContent({
  request,
  onCapabilitiesChange,
  showAppId = true,
}: AuthorizeCapabilitiesContentProps) {
  const manifest = request.params.manifest as AppCapabilities;
  const newCapabilityIndices = (request.params as any).newCapabilityIndices as number[] || [];
  // Convert plain object back to Map (Maps don't serialize properly through IPC)
  // IMPORTANT: Wrap in useMemo to prevent creating new Map instances on every render
  const contractNames = useMemo(() => {
    const contractNamesObj = (request.params as any).contractNames || {};
    return new Map<string, string>(Object.entries(contractNamesObj));
  }, [request.params]);

  const existingGrants = useMemo(() => {
    const existingGrantsObj = (request.params as any).existingGrants || {};
    return new Map<string, boolean>(Object.entries(existingGrantsObj));
  }, [request.params]);

  const { walletAPI } = useContext(WalletContext);

  // State for accounts capability
  const [accounts, setAccounts] = useState<AccountSelection[]>([]);
  const [isLoadingData, setIsLoadingData] = useState(true);

  // State for contracts capability - map of capIndex -> addressStr -> permission type -> boolean
  const [contractPermissions, setContractPermissions] = useState<Map<number, Map<string, { register: boolean, metadata: boolean }>>>(new Map());

  // State for contract classes capability - map of capIndex -> Set of class ID strings
  const [contractClassPermissions, setContractClassPermissions] = useState<Map<number, Set<string>>>(new Map());

  // State for simulation capability - map of capIndex -> Set of storage keys (e.g., "simulateTx:addr:func")
  const [simPermissions, setSimPermissions] = useState<Map<number, Set<string>>>(new Map());

  // State for transaction capability - map of capIndex -> Set of storage keys (e.g., "sendTx:addr:func")
  const [txPermissions, setTxPermissions] = useState<Map<number, Set<string>>>(new Map());

  const [selectedCapabilities, setSelectedCapabilities] = useState<Set<number>>(
    new Set(manifest.capabilities.map((_, i) => i))
  );
  // Only expand new capabilities by default, keep already granted ones collapsed
  const [expandedCapabilities, setExpandedCapabilities] = useState<Set<number>>(
    new Set(newCapabilityIndices)
  );
  const [contractMetadata, setContractMetadata] = useState<Map<string, string>>(new Map());

  // Behavior state
  const [mode, setMode] = useState<"strict" | "permissive">(
    manifest.behavior?.mode || "permissive"
  );
  const [duration, setDuration] = useState<number>(
    manifest.behavior?.expiration || 86400000 * 30
  );

  // Initialize permissions from manifest
  useEffect(() => {
    const loadData = async () => {
      // Determine if this is first time seeing the app
      const hasAnyExistingGrants = Array.from(existingGrants.values()).some(exists => exists);
      const isFirstTime = !hasAnyExistingGrants;

      // Load accounts
      const allAccounts: InternalAccount[] = await walletAPI.getAccounts();

      // Check if manifest requests accounts capability
      const accountsCap = manifest.capabilities.find(cap => cap.type === "accounts") as AccountsCapability | undefined;
      const shouldEnableAuthWit = accountsCap?.canCreateAuthWit ?? false;

      // Check if getAccounts is already granted
      const hasGetAccountsGrant = existingGrants.get("getAccounts") === true;

      setAccounts(
        allAccounts.map((acc) => ({
          address: acc.item.toString(),
          alias: acc.alias,
          originalAlias: acc.alias,
          selected: isFirstTime || hasGetAccountsGrant,  // First time: select all, Returning: only if granted
          allowAuthWit: shouldEnableAuthWit,  // Enable if manifest requests it
        }))
      );

      // Initialize contract permissions based on existing grants
      const contractPerms = new Map<number, Map<string, { register: boolean, metadata: boolean }>>();

      for (let i = 0; i < manifest.capabilities.length; i++) {
        const cap = manifest.capabilities[i];

        if (cap.type === "contracts" && Array.isArray(cap.contracts)) {
          const perms = new Map<string, { register: boolean, metadata: boolean }>();

          for (const addr of cap.contracts) {
            const addrStr = addr.toString();

            // Check existing grants for this contract
            const hasRegisterGrant = existingGrants.get(`registerContract:${addrStr}`) === true;
            const hasMetadataGrant = existingGrants.get(`getContractMetadata:${addrStr}`) === true;

            // First time: check all requested
            // Returning: only check if already granted
            perms.set(addrStr, {
              register: isFirstTime ? (cap.canRegister ?? false) : hasRegisterGrant,
              metadata: isFirstTime ? (cap.canGetMetadata ?? false) : hasMetadataGrant,
            });
          }

          contractPerms.set(i, perms);
        }
      }

      setContractPermissions(contractPerms);

      // Initialize contract class permissions
      const contractClassPerms = new Map<number, Set<string>>();

      for (let i = 0; i < manifest.capabilities.length; i++) {
        const cap = manifest.capabilities[i];

        if (cap.type === "contractClasses" && Array.isArray((cap as any).classes)) {
          const classes = new Set<string>();

          for (const classId of (cap as any).classes) {
            const classIdStr = classId.toString();

            // Check existing grant for this class ID
            const hasGrant = existingGrants.get(`getContractClassMetadata:${classIdStr}`) === true;

            // First time: check all requested
            // Returning: only check if already granted
            if (isFirstTime || hasGrant) {
              classes.add(classIdStr);
            }
          }

          if (classes.size > 0) {
            contractClassPerms.set(i, classes);
          }
        }
      }

      setContractClassPermissions(contractClassPerms);
      // Use pre-resolved contract names from prepare phase (via DecodingCache)
      setContractMetadata(contractNames);
      setIsLoadingData(false);
    };
    loadData();
    // Only run on mount - manifest shouldn't change during authorization request
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Build granted capabilities
  const buildGrantedCapabilities = useCallback((): GrantedCapability[] => {
    const granted: GrantedCapability[] = [];

    for (const index of selectedCapabilities) {
      const capability = manifest.capabilities[index];

      if (capability.type === "accounts") {
        const selectedAccs = accounts
          .filter((acc) => acc.selected)
          .map((acc) => ({
            item: AztecAddress.fromString(acc.address),
            alias: acc.alias,
          }));

        if (selectedAccs.length > 0) {
          const accountsCap = capability as AccountsCapability;
          // Determine if any selected account has authwit enabled
          const anyAuthWit = accounts.some(acc => acc.selected && acc.allowAuthWit);

          granted.push({
            type: "accounts",
            canGet: accountsCap.canGet,
            canCreateAuthWit: anyAuthWit ? accountsCap.canCreateAuthWit : false,
            accounts: selectedAccs,
          });
        }
      } else if (capability.type === "contracts") {
        const perms = contractPermissions.get(index);
        if (!perms) {
          granted.push(capability as GrantedCapability);
        } else {
          const contractsCap = capability as ContractsCapability;
          if (Array.isArray(contractsCap.contracts)) {
            // Group contracts by which permissions they have enabled
            // This is necessary because ContractsCapability doesn't support per-contract granularity
            const contractsWithRegister: AztecAddress[] = [];
            const contractsWithMetadata: AztecAddress[] = [];

            for (const addr of contractsCap.contracts) {
              const perm = perms.get(addr.toString());
              if (perm) {
                if (perm.register) contractsWithRegister.push(addr);
                if (perm.metadata) contractsWithMetadata.push(addr);
              }
            }

            // Create separate capability grants for each permission type
            // This ensures storage keys are only created for contracts with that specific permission
            if (contractsWithRegister.length > 0 && contractsCap.canRegister) {
              granted.push({
                type: "contracts",
                contracts: contractsWithRegister,
                canRegister: true,
                canGetMetadata: false,
              });
            }

            if (contractsWithMetadata.length > 0 && contractsCap.canGetMetadata) {
              granted.push({
                type: "contracts",
                contracts: contractsWithMetadata,
                canRegister: false,
                canGetMetadata: true,
              });
            }
          } else {
            granted.push(capability as GrantedCapability);
          }
        }
      } else if (capability.type === "contractClasses") {
        const classSet = contractClassPermissions.get(index);
        const contractClassesCap = capability as ContractClassesCapability;

        if (!classSet || contractClassesCap.classes === '*') {
          // Wildcard or no filtering - grant as-is
          granted.push(capability as GrantedCapability);
        } else {
          // Filter to only selected class IDs
          const approvedClasses = Array.isArray(contractClassesCap.classes)
            ? contractClassesCap.classes.filter(classId => classSet.has(classId.toString()))
            : [];

          if (approvedClasses.length > 0) {
            granted.push({
              type: "contractClasses",
              classes: approvedClasses,
              canGetMetadata: true,
            } as any);
          }
        }
      } else if (capability.type === "simulation") {
        const simCap = capability as SimulationCapability;
        const keySet = simPermissions.get(index);

        if (!keySet) {
          granted.push(capability as GrantedCapability);
        } else {
          const grantedCap: SimulationCapability = { ...simCap };

          if (simCap.transactions && simCap.transactions.scope !== "*") {
            const patterns = simCap.transactions.scope as ContractFunctionPattern[];
            const approved = patterns.filter((pattern) => {
              const contractKey = pattern.contract === "*" ? "*" : pattern.contract.toString();
              const storageKey = `simulateTx:${contractKey}:${pattern.function}`;
              return keySet.has(storageKey);
            });

            if (approved.length > 0) {
              grantedCap.transactions = { scope: approved };
            } else {
              delete grantedCap.transactions;
            }
          }

          if (simCap.utilities && simCap.utilities.scope !== "*") {
            const patterns = simCap.utilities.scope as ContractFunctionPattern[];
            const approved = patterns.filter((pattern) => {
              const contractKey = pattern.contract === "*" ? "*" : pattern.contract.toString();
              const storageKey = `simulateUtility:${contractKey}:${pattern.function}`;
              return keySet.has(storageKey);
            });

            if (approved.length > 0) {
              grantedCap.utilities = { scope: approved };
            } else {
              delete grantedCap.utilities;
            }
          }

          if (grantedCap.transactions || grantedCap.utilities) {
            granted.push(grantedCap as GrantedCapability);
          }
        }
      } else if (capability.type === "transaction") {
        const txCap = capability as TransactionCapability;
        const keySet = txPermissions.get(index);

        if (!keySet) {
          granted.push(txCap as GrantedCapability);
        } else {
          if (txCap.scope !== "*") {
            const patterns = txCap.scope as ContractFunctionPattern[];
            const approved = patterns.filter((pattern) => {
              const contractKey = pattern.contract === "*" ? "*" : pattern.contract.toString();
              const storageKey = `sendTx:${contractKey}:${pattern.function}`;
              return keySet.has(storageKey);
            });

            if (approved.length > 0) {
              granted.push({
                ...txCap,
                scope: approved,
              });
            }
          } else {
            granted.push(txCap as GrantedCapability);
          }
        }
      } else {
        granted.push(capability as GrantedCapability);
      }
    }

    return granted;
  }, [selectedCapabilities, accounts, contractPermissions, contractClassPermissions, simPermissions, txPermissions, manifest.capabilities]);

  useEffect(() => {
    if (onCapabilitiesChange && !isLoadingData) {
      const granted = buildGrantedCapabilities();
      onCapabilitiesChange({
        granted,
        mode,
        duration,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCapabilities, accounts, contractPermissions, contractClassPermissions, simPermissions, txPermissions, mode, duration, isLoadingData]);

  // Compute checked state for a capability based on its individual grants
  const getCapabilityCheckState = (capability: Capability, capIndex: number): { checked: boolean; indeterminate: boolean } => {
    if (capability.type === "accounts") {
      const accountsCap = capability as AccountsCapability;
      const selectedCount = accounts.filter(acc => acc.selected).length;

      if (selectedCount === 0) {
        return { checked: false, indeterminate: false };
      } else if (selectedCount === accounts.length) {
        return { checked: true, indeterminate: false };
      } else {
        return { checked: false, indeterminate: true };
      }
    }

    if (capability.type === "contracts") {
      const perms = contractPermissions.get(capIndex);
      if (!perms || perms.size === 0) {
        return { checked: true, indeterminate: false }; // No individual grants, use default
      }

      let anyEnabled = false;
      let allEnabled = true;

      for (const [_, perm] of perms) {
        const hasAny = perm.register || perm.metadata;
        if (hasAny) anyEnabled = true;
        if (!hasAny) allEnabled = false;
      }

      if (!anyEnabled) {
        return { checked: false, indeterminate: false };
      } else if (allEnabled) {
        return { checked: true, indeterminate: false };
      } else {
        return { checked: false, indeterminate: true };
      }
    }

    if (capability.type === "contractClasses") {
      const classes = contractClassPermissions.get(capIndex);
      const contractClassesCap = capability as ContractClassesCapability;

      if (contractClassesCap.classes === '*' || !Array.isArray(contractClassesCap.classes)) {
        return { checked: true, indeterminate: false }; // Wildcard, use default
      }

      if (!classes || classes.size === 0) {
        return { checked: false, indeterminate: false };
      } else if (classes.size === contractClassesCap.classes.length) {
        return { checked: true, indeterminate: false };
      } else {
        return { checked: false, indeterminate: true };
      }
    }

    if (capability.type === "simulation") {
      const keys = simPermissions.get(capIndex);
      const simCap = capability as SimulationCapability;

      // Count total patterns
      let totalPatterns = 0;
      if (simCap.transactions && simCap.transactions.scope !== "*") {
        totalPatterns += (simCap.transactions.scope as ContractFunctionPattern[]).length;
      }
      if (simCap.utilities && simCap.utilities.scope !== "*") {
        totalPatterns += (simCap.utilities.scope as ContractFunctionPattern[]).length;
      }

      if (totalPatterns === 0) {
        return { checked: true, indeterminate: false }; // Wildcard or no patterns
      }

      if (!keys || keys.size === 0) {
        return { checked: false, indeterminate: false };
      } else if (keys.size === totalPatterns) {
        return { checked: true, indeterminate: false };
      } else {
        return { checked: false, indeterminate: true };
      }
    }

    if (capability.type === "transaction") {
      const keys = txPermissions.get(capIndex);
      const txCap = capability as TransactionCapability;

      if (txCap.scope === "*") {
        return { checked: true, indeterminate: false }; // Wildcard
      }

      const patterns = txCap.scope as ContractFunctionPattern[];
      if (!keys || keys.size === 0) {
        return { checked: false, indeterminate: false };
      } else if (keys.size === patterns.length) {
        return { checked: true, indeterminate: false };
      } else {
        return { checked: false, indeterminate: true };
      }
    }

    // Default for other capability types
    return { checked: true, indeterminate: false };
  };

  const handleToggleCapability = (index: number) => {
    const capability = manifest.capabilities[index];
    const checkState = getCapabilityCheckState(capability, index);
    const shouldEnable = !checkState.checked; // If not fully checked, enable all; if fully checked, disable all

    // Toggle all individual grants based on the new state
    if (capability.type === "accounts") {
      setAccounts((prev: AccountSelection[]) => prev.map((acc: AccountSelection) => ({ ...acc, selected: shouldEnable })));
    } else if (capability.type === "contracts") {
      const contractsCap = capability as ContractsCapability;
      if (Array.isArray(contractsCap.contracts)) {
        setContractPermissions((prev: Map<number, Map<string, { register: boolean, metadata: boolean }>>) => {
          const next = new Map(prev);
          const perms: Map<string, { register: boolean, metadata: boolean }> = next.get(index) || new Map<string, { register: boolean, metadata: boolean }>();

          for (const addr of contractsCap.contracts as AztecAddress[]) {
            perms.set(addr.toString(), {
              register: shouldEnable && (contractsCap.canRegister ?? false),
              metadata: shouldEnable && (contractsCap.canGetMetadata ?? false),
            });
          }

          next.set(index, perms);
          return next;
        });
      }
    } else if (capability.type === "contractClasses") {
      const contractClassesCap = capability as ContractClassesCapability;
      if (Array.isArray(contractClassesCap.classes)) {
        setContractClassPermissions((prev: Map<number, Set<string>>) => {
          const next = new Map(prev);
          if (shouldEnable) {
            const classes = contractClassesCap.classes as any[];
            next.set(index, new Set(classes.map((c: any) => c.toString())));
          } else {
            next.set(index, new Set());
          }
          return next;
        });
      }
    } else if (capability.type === "simulation") {
      const simCap = capability as SimulationCapability;
      setSimPermissions((prev: Map<number, Set<string>>) => {
        const next = new Map(prev);

        if (shouldEnable) {
          const keys = new Set<string>();

          // Add all transaction simulation keys
          if (simCap.transactions && simCap.transactions.scope !== "*") {
            const patterns = simCap.transactions.scope as ContractFunctionPattern[];
            patterns.forEach((pattern) => {
              const contractKey = pattern.contract === "*" ? "*" : pattern.contract.toString();
              keys.add(`simulateTx:${contractKey}:${pattern.function}`);
            });
          }

          // Add all utility simulation keys
          if (simCap.utilities && simCap.utilities.scope !== "*") {
            const patterns = simCap.utilities.scope as ContractFunctionPattern[];
            patterns.forEach((pattern) => {
              const contractKey = pattern.contract === "*" ? "*" : pattern.contract.toString();
              keys.add(`simulateUtility:${contractKey}:${pattern.function}`);
            });
          }

          next.set(index, keys);
        } else {
          next.set(index, new Set());
        }

        return next;
      });
    } else if (capability.type === "transaction") {
      const txCap = capability as TransactionCapability;
      if (txCap.scope !== "*") {
        setTxPermissions((prev: Map<number, Set<string>>) => {
          const next = new Map(prev);

          if (shouldEnable) {
            const keys = new Set<string>();
            const patterns = txCap.scope as ContractFunctionPattern[];
            patterns.forEach((pattern) => {
              const contractKey = pattern.contract === "*" ? "*" : pattern.contract.toString();
              keys.add(`sendTx:${contractKey}:${pattern.function}`);
            });
            next.set(index, keys);
          } else {
            next.set(index, new Set());
          }

          return next;
        });
      }
    }
  };

  const handleToggleExpanded = (index: number) => {
    setExpandedCapabilities((prev) => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  };

  const handleToggleAccount = (index: number) => {
    setAccounts((prev) =>
      prev.map((acc, i) =>
        i === index ? { ...acc, selected: !acc.selected } : acc
      )
    );
  };

  const handleToggleAuthWit = (index: number) => {
    setAccounts((prev) =>
      prev.map((acc, i) =>
        i === index ? { ...acc, allowAuthWit: !acc.allowAuthWit } : acc
      )
    );
  };

  const handleAliasChange = (index: number, newAlias: string) => {
    setAccounts((prev) =>
      prev.map((acc, i) => (i === index ? { ...acc, alias: newAlias } : acc))
    );
  };

  const handleContractPermissionToggle = (capIndex: number, addressStr: string, permType: 'register' | 'metadata') => {
    setContractPermissions(prev => {
      const next = new Map(prev);
      const capPerms = next.get(capIndex) || new Map<string, { register: boolean, metadata: boolean }>();
      const addrPerms = capPerms.get(addressStr) || { register: false, metadata: false };
      capPerms.set(addressStr, {
        ...addrPerms,
        [permType]: !addrPerms[permType as keyof typeof addrPerms],
      });
      next.set(capIndex, capPerms);
      return next;
    });
  };

  // Group patterns by contract for simulation/transaction
  const groupPatternsByContract = (patterns: ContractFunctionPattern[]): Map<string, Set<number>> => {
    const grouped = new Map<string, Set<number>>();
    patterns.forEach((pattern, idx) => {
      const key = pattern.contract === "*" ? "*" : pattern.contract.toString();
      if (!grouped.has(key)) {
        grouped.set(key, new Set<number>());
      }
      grouped.get(key)!.add(idx);
    });
    return grouped;
  };

  const handleSimPatternToggle = (capIndex: number, storageKey: string) => {
    setSimPermissions(prev => {
      const next = new Map(prev);
      const keySet = next.get(capIndex) || new Set<string>();
      const updated = new Set(keySet);

      if (updated.has(storageKey)) {
        updated.delete(storageKey);
      } else {
        updated.add(storageKey);
      }

      next.set(capIndex, updated);
      return next;
    });
  };

  const handleTxPatternToggle = (capIndex: number, storageKey: string) => {
    setTxPermissions(prev => {
      const next = new Map(prev);
      const keySet = next.get(capIndex) || new Set<string>();
      const updated = new Set(keySet);

      if (updated.has(storageKey)) {
        updated.delete(storageKey);
      } else {
        updated.add(storageKey);
      }

      next.set(capIndex, updated);
      return next;
    });
  };

  // Initialize sim/tx permissions based on mode:
  // - First time (no grants exist): Check all requested permissions
  // - Returning app (some grants exist): Only check already-granted permissions
  useEffect(() => {
    const simPerms = new Map<number, Set<string>>();
    const txPerms = new Map<number, Set<string>>();

    // Determine if this is first time seeing the app
    const hasAnyExistingGrants = Array.from(existingGrants.values()).some(exists => exists);
    const isFirstTime = !hasAnyExistingGrants;

    manifest.capabilities.forEach((cap, idx) => {
      if (cap.type === "simulation") {
        const keys = new Set<string>();

        // Handle transaction simulations
        if (cap.transactions?.scope !== "*") {
          const patterns = cap.transactions.scope as ContractFunctionPattern[];
          patterns.forEach((pattern) => {
            const contractKey = pattern.contract === "*" ? "*" : pattern.contract.toString();
            const storageKey = `simulateTx:${contractKey}:${pattern.function}`;

            // First time: check all requested
            // Returning: only check if already granted
            if (isFirstTime || existingGrants.get(storageKey)) {
              keys.add(storageKey);
            }
          });
        }

        // Handle utility simulations
        if (cap.utilities?.scope !== "*") {
          const patterns = cap.utilities.scope as ContractFunctionPattern[];
          patterns.forEach((pattern) => {
            const contractKey = pattern.contract === "*" ? "*" : pattern.contract.toString();
            const storageKey = `simulateUtility:${contractKey}:${pattern.function}`;

            if (isFirstTime || existingGrants.get(storageKey)) {
              keys.add(storageKey);
            }
          });
        }

        if (keys.size > 0) {
          simPerms.set(idx, keys);
        }
      }

      if (cap.type === "transaction" && cap.scope !== "*") {
        const patterns = cap.scope as ContractFunctionPattern[];
        const keys = new Set<string>();
        patterns.forEach((pattern) => {
          const contractKey = pattern.contract === "*" ? "*" : pattern.contract.toString();
          const storageKey = `sendTx:${contractKey}:${pattern.function}`;

          if (isFirstTime || existingGrants.get(storageKey)) {
            keys.add(storageKey);
          }
        });
        if (keys.size > 0) {
          txPerms.set(idx, keys);
        }
      }
    });

    setSimPermissions(simPerms);
    setTxPermissions(txPerms);
  }, [manifest.capabilities, existingGrants]);

  const durationDays = Math.floor(duration / 86400000);

  return (
    <>
      {/* App Metadata - Compact */}
      <Box sx={{ mb: 2, p: 1.5, bgcolor: "action.hover", borderRadius: 1 }}>
        <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
          <Typography variant="subtitle1" fontWeight={600}>
            {manifest.metadata.name}
          </Typography>
          {manifest.metadata.version && (
            <Chip label={`v${manifest.metadata.version}`} size="small" />
          )}
        </Box>
        {manifest.metadata.description && (
          <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5, display: "block" }}>
            {manifest.metadata.description}
          </Typography>
        )}
      </Box>

      {showAppId && newCapabilityIndices.length < manifest.capabilities.length && (
        <Box sx={{ mb: 1.5, p: 1, bgcolor: "success.main", color: "success.contrastText", borderRadius: 1 }}>
          <Typography variant="caption" fontWeight={600}>
            {newCapabilityIndices.length === 0
              ? "✓ All capabilities already granted"
              : `✓ ${manifest.capabilities.length - newCapabilityIndices.length} of ${manifest.capabilities.length} already granted`}
          </Typography>
        </Box>
      )}

      {/* Capabilities List - Compact */}
      <List sx={{ mt: 1, p: 0 }}>
        {manifest.capabilities.map((capability, index) => {
          const checkState = getCapabilityCheckState(capability, index);
          const isExpanded = expandedCapabilities.has(index);
          const isAccountsCapability = capability.type === "accounts";
          const isTransactionCapability = capability.type === "transaction";
          const isNewCapability = newCapabilityIndices.includes(index);
          const isAlreadyGranted = !isNewCapability;

          return (
            <Accordion
              key={index}
              expanded={isExpanded}
              onChange={() => handleToggleExpanded(index)}
              sx={{
                mb: 0.5,
                border: 1,
                borderColor: checkState.checked ? "primary.main" : "divider",
                "&:before": { display: "none" },
                opacity: isAlreadyGranted && !isTransactionCapability ? 0.6 : 1,
                boxShadow: "none",
              }}
            >
              <AccordionSummary
                expandIcon={<ExpandMoreIcon fontSize="small" />}
                sx={{
                  px: 1.5,
                  py: 0.5,
                  minHeight: "unset",
                  "& .MuiAccordionSummary-content": { my: 0.5 }
                }}
              >
                <Box sx={{ display: "flex", alignItems: "center", gap: 1, width: "100%" }}>
                  <Checkbox
                    checked={checkState.checked}
                    indeterminate={checkState.indeterminate}
                    onChange={() => handleToggleCapability(index)}
                    onClick={(e) => e.stopPropagation()}
                    size="small"
                    disabled={isTransactionCapability}
                    sx={{ p: 0 }}
                  />
                  <Box sx={{ fontSize: "1.2rem", display: "flex", alignItems: "center" }}>
                    {getCapabilityIcon(capability.type)}
                  </Box>
                  <Box sx={{ flexGrow: 1, display: "flex", alignItems: "center", gap: 0.5 }}>
                    <Typography variant="body2" fontWeight={isNewCapability && !isTransactionCapability ? 600 : 400}>
                      {getCapabilityTypeName(capability.type)}
                    </Typography>
                    {isTransactionCapability && (
                      <Chip
                        label="Always requires approval"
                        size="small"
                        color="warning"
                        variant="outlined"
                        sx={{ height: 18, fontSize: "0.7rem" }}
                      />
                    )}
                    {isAlreadyGranted && !isTransactionCapability && (
                      <Chip
                        label="✓"
                        size="small"
                        color="success"
                        variant="outlined"
                        sx={{ height: 18, fontSize: "0.7rem" }}
                      />
                    )}
                  </Box>
                </Box>
              </AccordionSummary>

              <AccordionDetails sx={{ pt: 0, pb: 1, pl: 5, pr: 1.5 }}>
                {/* Accounts Capability */}
                {isAccountsCapability && (
                  <Box>
                    {accounts.map((account, accIndex) => (
                      <Box
                        key={account.address}
                        sx={{
                          p: 1,
                          mb: 0.5,
                          border: 1,
                          borderColor: account.selected ? "primary.main" : "divider",
                          borderRadius: 0.5,
                          bgcolor: account.selected ? "action.hover" : "background.paper",
                        }}
                      >
                        <FormControlLabel
                          control={
                            <Checkbox
                              size="small"
                              checked={account.selected}
                              onChange={() => handleToggleAccount(accIndex)}
                            />
                          }
                          label={
                            <Box>
                              <Typography variant="body2" fontWeight={account.selected ? 600 : 400}>
                                {account.originalAlias}
                              </Typography>
                              <Typography variant="caption" color="text.secondary" sx={{ fontFamily: "monospace", fontSize: "0.7rem" }}>
                                {account.address.slice(0, 16)}...{account.address.slice(-8)}
                              </Typography>
                            </Box>
                          }
                          sx={{ m: 0 }}
                        />
                        {account.selected && (
                          <Box sx={{ pl: 3.5, mt: 0.5 }}>
                            <FormControlLabel
                              control={
                                <Checkbox
                                  size="small"
                                  checked={account.allowAuthWit}
                                  onChange={() => handleToggleAuthWit(accIndex)}
                                  disabled={!(capability as AccountsCapability).canCreateAuthWit}
                                />
                              }
                              label={<Typography variant="caption">Allow auth witnesses</Typography>}
                              sx={{ m: 0 }}
                            />
                            <TextField
                              size="small"
                              value={account.alias}
                              onChange={(e) => handleAliasChange(accIndex, e.target.value)}
                              label="Alias"
                              fullWidth
                              sx={{ mt: 0.5 }}
                              InputProps={{ sx: { fontSize: "0.875rem" } }}
                              InputLabelProps={{ sx: { fontSize: "0.875rem" } }}
                            />
                          </Box>
                        )}
                      </Box>
                    ))}
                  </Box>
                )}

                {/* Contracts Capability */}
                {capability.type === "contracts" && (
                  <Box>
                    {(capability as ContractsCapability).contracts === "*" ? (
                      <Typography variant="caption" color="warning.main">
                        ⚠️ All contracts (wildcard)
                      </Typography>
                    ) : (
                      <>
                        {((capability as ContractsCapability).contracts as AztecAddress[]).map((address) => {
                          const addressStr = address.toString();
                          const perms = contractPermissions.get(index)?.get(addressStr);
                          const name = contractMetadata.get(addressStr);
                          const shortAddr = `${addressStr.slice(0, 10)}...${addressStr.slice(-8)}`;

                          return (
                            <Box key={addressStr} sx={{ mb: 0.5, display: "flex", alignItems: "center", gap: 0.5, flexWrap: "wrap" }}>
                              {name && (
                                <Chip
                                  label={name}
                                  size="small"
                                  color="default"
                                  sx={{ fontWeight: 600, height: 20, fontSize: "0.7rem" }}
                                />
                              )}
                              <Typography variant="caption" color="text.secondary" sx={{ fontFamily: "monospace", fontSize: "0.7rem" }}>
                                {shortAddr}
                              </Typography>
                              {(capability as ContractsCapability).canRegister && (
                                <Chip
                                  label="Register"
                                  size="small"
                                  color={perms?.register ? "primary" : "default"}
                                  onClick={() => handleContractPermissionToggle(index, addressStr, 'register')}
                                  sx={{ cursor: "pointer", height: 20, fontSize: "0.7rem" }}
                                />
                              )}
                              {(capability as ContractsCapability).canGetMetadata && (
                                <Chip
                                  label="Metadata"
                                  size="small"
                                  color={perms?.metadata ? "primary" : "default"}
                                  onClick={() => handleContractPermissionToggle(index, addressStr, 'metadata')}
                                  sx={{ cursor: "pointer", height: 20, fontSize: "0.7rem" }}
                                />
                              )}
                            </Box>
                          );
                        })}
                      </>
                    )}
                  </Box>
                )}

                {/* Contract Classes Capability */}
                {capability.type === "contractClasses" && (
                  <Box>
                    {(capability as ContractClassesCapability).classes === "*" ? (
                      <Typography variant="caption" color="warning.main">
                        ⚠️ Any contract class (wildcard)
                      </Typography>
                    ) : (
                      <>
                        {((capability as ContractClassesCapability).classes as any[]).map((classId, classIdx) => {
                          const classIdStr = classId.toString();
                          const shortClassId = `${classIdStr.slice(0, 12)}...${classIdStr.slice(-8)}`;
                          const isSelected = contractClassPermissions.get(index)?.has(classIdStr) ?? false;

                          return (
                            <Box key={classIdStr} sx={{ mb: 0.5, display: "flex", alignItems: "center", gap: 0.5, flexWrap: "wrap" }}>
                              <FormControlLabel
                                control={
                                  <Checkbox
                                    size="small"
                                    checked={isSelected}
                                    onChange={() => {
                                      setContractClassPermissions(prev => {
                                        const next = new Map(prev);
                                        const classes = next.get(index) || new Set<string>();
                                        const updated = new Set(classes);
                                        if (updated.has(classIdStr)) {
                                          updated.delete(classIdStr);
                                        } else {
                                          updated.add(classIdStr);
                                        }
                                        next.set(index, updated);
                                        return next;
                                      });
                                    }}
                                  />
                                }
                                label={
                                  <Typography variant="caption" color="text.secondary" sx={{ fontFamily: "monospace", fontSize: "0.7rem" }}>
                                    {shortClassId}
                                  </Typography>
                                }
                                sx={{ m: 0 }}
                              />
                            </Box>
                          );
                        })}
                      </>
                    )}
                  </Box>
                )}

                {/* Simulation Capability */}
                {capability.type === "simulation" && (capability as SimulationCapability).transactions && (
                  <Box>
                    {/* Transaction Simulations Section */}
                    <Box sx={{ mb: 1 }}>
                      <Typography variant="caption" sx={{ fontWeight: 600, display: "block", mb: 0.5 }}>
                        Transaction Simulations (simulateTx)
                      </Typography>
                      {(capability as SimulationCapability).transactions?.scope === "*" ? (
                        <Typography variant="caption" color="warning.main">
                          ⚠️ Any transaction (wildcard)
                        </Typography>
                      ) : (
                        <>
                          {Array.from(groupPatternsByContract((capability as SimulationCapability).transactions!.scope as ContractFunctionPattern[]).entries()).map(([contractKey, patternIndices]) => {
                            const patterns = (capability as SimulationCapability).transactions!.scope as ContractFunctionPattern[];
                            const contract = patterns[Array.from(patternIndices)[0]].contract;
                            const keySet = simPermissions.get(index) || new Set<string>();

                            return (
                              <Box key={contractKey} sx={{ mb: 0.5 }}>
                                <Typography variant="caption" fontWeight={600} sx={{ display: "block", mb: 0.25 }}>
                                  {contractKey === "*" ? "Any Contract" : formatContractAddress(contract as AztecAddress, contractMetadata)}
                                </Typography>
                                <Box sx={{ ml: 1, display: "flex", flexWrap: "wrap", gap: 0.5 }}>
                                  {Array.from(patternIndices).map((idx: number) => {
                                    const pattern = patterns[idx];
                                    const funcName = pattern.function === "*" ? "any function" : pattern.function;
                                    const storageKey = `simulateTx:${contractKey}:${pattern.function}`;

                                    return (
                                      <FormControlLabel
                                        key={idx}
                                        control={
                                          <Checkbox
                                            size="small"
                                            checked={keySet.has(storageKey)}
                                            onChange={() => handleSimPatternToggle(index, storageKey)}
                                            sx={{ p: 0.25 }}
                                          />
                                        }
                                        label={<Typography variant="caption" sx={{ fontFamily: "monospace", fontSize: "0.7rem" }}>{funcName}</Typography>}
                                        sx={{ m: 0, mr: 1 }}
                                      />
                                    );
                                  })}
                                </Box>
                              </Box>
                            );
                          })}
                        </>
                      )}
                    </Box>

                    {/* Utility Simulations Section */}
                    {(capability as SimulationCapability).utilities && (
                      <Box>
                        <Typography variant="caption" sx={{ fontWeight: 600, display: "block", mb: 0.5, mt: 1 }}>
                          Utility Simulations (simulateUtility)
                        </Typography>
                        {(capability as SimulationCapability).utilities?.scope === "*" ? (
                          <Typography variant="caption" color="warning.main">
                            ⚠️ Any utility function (wildcard)
                          </Typography>
                        ) : (
                          <>
                            {Array.from(groupPatternsByContract((capability as SimulationCapability).utilities!.scope as ContractFunctionPattern[]).entries()).map(([contractKey, patternIndices]) => {
                              const patterns = (capability as SimulationCapability).utilities!.scope as ContractFunctionPattern[];
                              const contract = patterns[Array.from(patternIndices)[0]].contract;
                              const keySet = simPermissions.get(index) || new Set<string>();

                            return (
                              <Box key={`utility-${contractKey}`} sx={{ mb: 0.5 }}>
                                <Typography variant="caption" fontWeight={600} sx={{ display: "block", mb: 0.25 }}>
                                  {contractKey === "*" ? "Any Contract" : formatContractAddress(contract as AztecAddress, contractMetadata)}
                                </Typography>
                                <Box sx={{ ml: 1, display: "flex", flexWrap: "wrap", gap: 0.5 }}>
                                  {Array.from(patternIndices).map((idx: number) => {
                                    const pattern = patterns[idx];
                                    const funcName = pattern.function === "*" ? "any function" : pattern.function;
                                    const storageKey = `simulateUtility:${contractKey}:${pattern.function}`;

                                    return (
                                      <FormControlLabel
                                        key={`utility-${idx}`}
                                        control={
                                          <Checkbox
                                            size="small"
                                            checked={keySet.has(storageKey)}
                                            onChange={() => handleSimPatternToggle(index, storageKey)}
                                            sx={{ p: 0.25 }}
                                          />
                                        }
                                        label={<Typography variant="caption" sx={{ fontFamily: "monospace", fontSize: "0.7rem" }}>{funcName}</Typography>}
                                        sx={{ m: 0, mr: 1 }}
                                      />
                                    );
                                  })}
                                </Box>
                              </Box>
                            );
                          })}
                        </>
                      )}
                      </Box>
                    )}
                  </Box>
                )}

                {/* Transaction Capability */}
                {capability.type === "transaction" && (
                  <Box>
                    {(capability as TransactionCapability).scope === "*" ? (
                      <Typography variant="caption" color="warning.main">
                        ⚠️ Any transaction (wildcard)
                      </Typography>
                    ) : (
                      <>
                        {Array.from(groupPatternsByContract((capability as TransactionCapability).scope as ContractFunctionPattern[]).entries()).map(([contractKey, patternIndices]) => {
                          const patterns = (capability as TransactionCapability).scope as ContractFunctionPattern[];
                          const contract = patterns[Array.from(patternIndices)[0]].contract;
                          const keySet = txPermissions.get(index) || new Set<string>();

                          return (
                            <Box key={contractKey} sx={{ mb: 0.5 }}>
                              <Typography variant="caption" fontWeight={600} sx={{ display: "block", mb: 0.25 }}>
                                {contractKey === "*" ? "Any Contract" : formatContractAddress(contract as AztecAddress, contractMetadata)}
                              </Typography>
                              <Box sx={{ ml: 1, display: "flex", flexWrap: "wrap", gap: 0.5 }}>
                                {Array.from(patternIndices).map((idx: number) => {
                                  const pattern = patterns[idx];
                                  const funcName = pattern.function === "*" ? "any function" : pattern.function;

                                  return (
                                    <Chip
                                      key={idx}
                                      label={funcName}
                                      size="small"
                                      variant="outlined"
                                      sx={{
                                        height: 20,
                                        fontSize: "0.7rem",
                                        fontFamily: "monospace",
                                      }}
                                    />
                                  );
                                })}
                              </Box>
                            </Box>
                          );
                        })}
                      </>
                    )}
                  </Box>
                )}

                {/* Data Capability */}
                {capability.type === "data" && (
                  <Box>
                    {(capability as DataCapability).addressBook && (
                      <Typography variant="caption" gutterBottom sx={{ display: "block" }}>
                        • Access to address book
                      </Typography>
                    )}
                    {(capability as DataCapability).privateEvents && (
                      <Typography variant="caption" sx={{ display: "block" }}>
                        • Private events from{" "}
                        {(capability as DataCapability).privateEvents?.contracts === "*"
                          ? "all contracts"
                          : `${((capability as DataCapability).privateEvents?.contracts as AztecAddress[]).length} contract(s)`}
                      </Typography>
                    )}
                  </Box>
                )}
              </AccordionDetails>
            </Accordion>
          );
        })}
      </List>

      {/* Behavior Customization - Compact */}
      <Box sx={{ mt: 1.5, p: 1.5, border: 1, borderColor: "divider", borderRadius: 1, bgcolor: "action.hover" }}>
        <Typography variant="caption" fontWeight={600} sx={{ display: "block", mb: 1 }}>
          Authorization Settings
        </Typography>

        <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", mb: 1 }}>
          <Typography variant="caption" color="text.secondary">
            {mode === "permissive"
              ? "Allow ad-hoc requests"
              : "Strict mode (only declared ops)"}
          </Typography>
          <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
            <Typography variant="caption" color={mode === "permissive" ? "primary.main" : "text.secondary"} fontWeight={mode === "permissive" ? 600 : 400}>
              Permissive
            </Typography>
            <Switch
              size="small"
              checked={mode === "strict"}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setMode(e.target.checked ? "strict" : "permissive")}
              color="warning"
            />
            <Typography variant="caption" color={mode === "strict" ? "warning.main" : "text.secondary"} fontWeight={mode === "strict" ? 600 : 400}>
              Strict
            </Typography>
          </Box>
        </Box>

        <TextField
          fullWidth
          size="small"
          label="Duration (days)"
          type="number"
          value={durationDays}
          onChange={(e) => setDuration(parseInt(e.target.value) * 86400000)}
          InputProps={{ sx: { fontSize: "0.875rem" } }}
          InputLabelProps={{ sx: { fontSize: "0.875rem" } }}
        />
      </Box>

      <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: "block", fontStyle: "italic" }}>
        Permissions persist for {durationDays} days and can be revoked from settings.
      </Typography>
    </>
  );
}
