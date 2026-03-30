import { useContext, useEffect, useState, useCallback, useMemo } from "react";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import List from "@mui/material/List";
import Chip from "@mui/material/Chip";
import Checkbox from "@mui/material/Checkbox";
import Accordion from "@mui/material/Accordion";
import AccordionSummary from "@mui/material/AccordionSummary";
import AccordionDetails from "@mui/material/AccordionDetails";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import TextField from "@mui/material/TextField";
import Switch from "@mui/material/Switch";
import type {
  AuthorizationItem,
  RequestCapabilitiesParams,
} from "../../../wallet/types/authorization";
import type {
  Capability,
  ContractFunctionPattern,
} from "@aztec/aztec.js/wallet";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import type { Aliased } from "@aztec/aztec.js/wallet";
import { WalletContext } from "../../renderer";
import type { InternalAccount } from "../../../wallet/core/internal-wallet";
import {
  type AccountSelection,
  type AccountsCapability,
  type ContractsCapability,
  type ContractClassesCapability,
  type SimulationCapability,
  type TransactionCapability,
  type DataCapability,
  type GrantedCapability,
  getCapabilityIcon,
  getCapabilityTypeName,
  AccountsCapabilityDetails,
  ContractsCapabilityDetails,
  ContractClassesCapabilityDetails,
  SimulationCapabilityDetails,
  TransactionCapabilityDetails,
  DataCapabilityDetails,
} from "./capabilities";

interface AuthorizeCapabilitiesContentProps {
  request: AuthorizationItem<RequestCapabilitiesParams>;
  onCapabilitiesChange?: (data: {
    granted: GrantedCapability[];
    // Wallet-internal settings (not sent to app)
    mode: "strict" | "permissive";
    duration: number;
  }) => void;
  showAppId?: boolean;
  compact?: boolean;
}

export function AuthorizeCapabilitiesContent({
  request,
  onCapabilitiesChange,
  showAppId = true,
  compact,
}: AuthorizeCapabilitiesContentProps) {
  const manifest = request.params.manifest;
  const newCapabilityIndices = request.params.newCapabilityIndices;
  const isAppFirstTime = request.params.isAppFirstTime;

  // Convert plain object back to Map (Maps don't serialize properly through IPC)
  // IMPORTANT: Wrap in useMemo to prevent creating new Map instances on every render
  const contractNames = useMemo(() => {
    return new Map<string, string>(
      Object.entries(request.params.contractNames),
    );
  }, [request.params.contractNames]);

  const existingGrants = useMemo(() => {
    return new Map<string, boolean>(
      Object.entries(request.params.existingGrants),
    );
  }, [request.params.existingGrants]);

  const { walletAPI } = useContext(WalletContext);

  // State for accounts capability
  const [accounts, setAccounts] = useState<AccountSelection[]>([]);
  const [isLoadingData, setIsLoadingData] = useState(true);

  // State for contracts capability - map of capIndex -> addressStr -> permission type -> boolean
  const [contractPermissions, setContractPermissions] = useState<
    Map<number, Map<string, { register: boolean; metadata: boolean }>>
  >(new Map());

  // State for contract classes capability - map of capIndex -> Set of class ID strings
  const [contractClassPermissions, setContractClassPermissions] = useState<
    Map<number, Set<string>>
  >(new Map());

  // State for simulation capability - map of capIndex -> Set of storage keys (e.g., "simulateTx:addr:func")
  const [simPermissions, setSimPermissions] = useState<
    Map<number, Set<string>>
  >(new Map());

  // State for transaction capability - map of capIndex -> Set of storage keys (e.g., "sendTx:addr:func")
  const [txPermissions, setTxPermissions] = useState<Map<number, Set<string>>>(
    new Map(),
  );

  const [selectedCapabilities, setSelectedCapabilities] = useState<Set<number>>(
    new Set(manifest.capabilities.map((_, i) => i)),
  );
  // Only expand new capabilities by default, keep already granted ones collapsed
  const [expandedCapabilities, setExpandedCapabilities] = useState<Set<number>>(
    new Set(newCapabilityIndices),
  );
  const [contractMetadata, setContractMetadata] = useState<Map<string, string>>(
    new Map(),
  );

  // Behavior state
  const [mode, setMode] = useState<"strict" | "permissive">("permissive");
  const [duration, setDuration] = useState<number>(86400000 * 30);

  // Initialize permissions from manifest
  useEffect(() => {
    const loadData = async () => {
      // Load accounts
      const allAccounts: InternalAccount[] = await walletAPI.getAccounts();

      // Check if manifest requests accounts capability
      const accountsCap = manifest.capabilities.find(
        (cap) => cap.type === "accounts",
      ) as AccountsCapability | undefined;
      // Build the set of previously-granted account addresses (from the capability's accounts list)
      const grantedAddresses = new Set<string>(
        (accountsCap as any)?.accounts?.map((a: Aliased<AztecAddress>) => a.item.toString()) ?? [],
      );
      const hasGetAccountsGrant = existingGrants.get("getAccounts") === true;

      setAccounts(
        allAccounts.map((acc) => ({
          address: acc.item.toString(),
          alias: acc.alias,
          originalAlias: acc.alias,
          // First time: select all.
          // Returning: select only if this specific account was previously granted.
          // (Falls back to full grant if no per-account list is present.)
          selected: isAppFirstTime
            ? true
            : grantedAddresses.size > 0
              ? grantedAddresses.has(acc.item.toString())
              : hasGetAccountsGrant,
        })),
      );

      // Initialize contract permissions based on existing grants
      const contractPerms = new Map<
        number,
        Map<string, { register: boolean; metadata: boolean }>
      >();

      for (let i = 0; i < manifest.capabilities.length; i++) {
        const cap = manifest.capabilities[i];

        if (cap.type === "contracts" && Array.isArray(cap.contracts)) {
          const perms = new Map<
            string,
            { register: boolean; metadata: boolean }
          >();

          for (const addr of cap.contracts) {
            const addrStr = addr.toString();

            // Check existing grants for this contract
            const hasRegisterGrant =
              existingGrants.get(`registerContract:${addrStr}`) === true;
            const hasMetadataGrant =
              existingGrants.get(`getContractMetadata:${addrStr}`) === true;

            // First time: check all requested
            // Returning: only check if already granted
            perms.set(addrStr, {
              register: isAppFirstTime
                ? (cap.canRegister ?? false)
                : hasRegisterGrant,
              metadata: isAppFirstTime
                ? (cap.canGetMetadata ?? false)
                : hasMetadataGrant,
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

        if (
          cap.type === "contractClasses" &&
          Array.isArray((cap as any).classes)
        ) {
          const classes = new Set<string>();

          for (const classId of (cap as any).classes) {
            const classIdStr = classId.toString();

            // Check existing grant for this class ID
            const hasGrant =
              existingGrants.get(`getContractClassMetadata:${classIdStr}`) ===
              true;

            // First time: check all requested
            // Returning: only check if already granted
            if (isAppFirstTime || hasGrant) {
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
  }, [existingGrants, manifest.capabilities, isAppFirstTime, walletAPI]);

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

          granted.push({
            type: "accounts",
            canGet: accountsCap.canGet,
            canCreateAuthWit: accountsCap.canCreateAuthWit,
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

            if (
              contractsWithMetadata.length > 0 &&
              contractsCap.canGetMetadata
            ) {
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

        if (!classSet || contractClassesCap.classes === "*") {
          // Wildcard or no filtering - grant as-is
          granted.push(capability as GrantedCapability);
        } else {
          // Filter to only selected class IDs
          const approvedClasses = Array.isArray(contractClassesCap.classes)
            ? contractClassesCap.classes.filter((classId) =>
                classSet.has(classId.toString()),
              )
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
            const patterns = simCap.transactions
              .scope as ContractFunctionPattern[];
            const approved = patterns.filter((pattern) => {
              const contractKey =
                pattern.contract === "*" ? "*" : pattern.contract.toString();
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
            const patterns = simCap.utilities
              .scope as ContractFunctionPattern[];
            const approved = patterns.filter((pattern) => {
              const contractKey =
                pattern.contract === "*" ? "*" : pattern.contract.toString();
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
              const contractKey =
                pattern.contract === "*" ? "*" : pattern.contract.toString();
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
  }, [
    selectedCapabilities,
    accounts,
    contractPermissions,
    contractClassPermissions,
    simPermissions,
    txPermissions,
    manifest.capabilities,
  ]);

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
  }, [
    selectedCapabilities,
    accounts,
    contractPermissions,
    contractClassPermissions,
    simPermissions,
    txPermissions,
    mode,
    duration,
    isLoadingData,
  ]);

  // Compute checked state for a capability based on its individual grants
  const getCapabilityCheckState = (
    capability: Capability,
    capIndex: number,
  ): { checked: boolean; indeterminate: boolean } => {
    if (capability.type === "accounts") {
      const accountsCap = capability as AccountsCapability;
      const selectedCount = accounts.filter((acc) => acc.selected).length;

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

      if (
        contractClassesCap.classes === "*" ||
        !Array.isArray(contractClassesCap.classes)
      ) {
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
        totalPatterns += (
          simCap.transactions.scope as ContractFunctionPattern[]
        ).length;
      }
      if (simCap.utilities && simCap.utilities.scope !== "*") {
        totalPatterns += (simCap.utilities.scope as ContractFunctionPattern[])
          .length;
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
      setAccounts((prev) =>
        prev.map((acc) => ({
          ...acc,
          selected: shouldEnable,
        })),
      );
    } else if (capability.type === "contracts") {
      const contractsCap = capability as ContractsCapability;
      if (Array.isArray(contractsCap.contracts)) {
        setContractPermissions((prev) => {
          const next = new Map(prev);
          let perms = next.get(index);
          if (!perms) {
            perms = new Map<string, { register: boolean; metadata: boolean }>();
          }

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
        setContractClassPermissions((prev) => {
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
      setSimPermissions((prev) => {
        const next = new Map(prev);

        if (shouldEnable) {
          const keys = new Set<string>();

          // Add all transaction simulation keys
          if (simCap.transactions && simCap.transactions.scope !== "*") {
            const patterns = simCap.transactions
              .scope as ContractFunctionPattern[];
            patterns.forEach((pattern) => {
              const contractKey =
                pattern.contract === "*" ? "*" : pattern.contract.toString();
              keys.add(`simulateTx:${contractKey}:${pattern.function}`);
            });
          }

          // Add all utility simulation keys
          if (simCap.utilities && simCap.utilities.scope !== "*") {
            const patterns = simCap.utilities
              .scope as ContractFunctionPattern[];
            patterns.forEach((pattern) => {
              const contractKey =
                pattern.contract === "*" ? "*" : pattern.contract.toString();
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
              const contractKey =
                pattern.contract === "*" ? "*" : pattern.contract.toString();
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
        i === index ? { ...acc, selected: !acc.selected } : acc,
      ),
    );
  };


  const handleAliasChange = (index: number, newAlias: string) => {
    setAccounts((prev) =>
      prev.map((acc, i) => (i === index ? { ...acc, alias: newAlias } : acc)),
    );
  };

  const handleContractPermissionToggle = (
    capIndex: number,
    addressStr: string,
    permType: "register" | "metadata",
  ) => {
    setContractPermissions((prev) => {
      const next = new Map(prev);
      let capPerms = next.get(capIndex);
      if (!capPerms) {
        capPerms = new Map<string, { register: boolean; metadata: boolean }>();
      }
      const addrPerms = capPerms.get(addressStr) ?? {
        register: false,
        metadata: false,
      };
      capPerms.set(addressStr, {
        ...addrPerms,
        [permType]: !addrPerms[permType],
      });
      next.set(capIndex, capPerms);
      return next;
    });
  };

  const handleSimPatternToggle = (capIndex: number, storageKey: string) => {
    setSimPermissions((prev) => {
      const next = new Map(prev);
      const keySet = next.get(capIndex) ?? new Set<string>();
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
    setTxPermissions((prev: Map<number, Set<string>>) => {
      const next = new Map(prev);
      const keySet = next.get(capIndex) ?? new Set<string>();
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

    manifest.capabilities.forEach((cap, idx) => {
      if (cap.type === "simulation") {
        const keys = new Set<string>();

        // Handle transaction simulations
        if (cap.transactions && cap.transactions.scope !== "*") {
          const patterns = cap.transactions.scope as ContractFunctionPattern[];
          patterns.forEach((pattern) => {
            const contractKey =
              pattern.contract === "*" ? "*" : pattern.contract.toString();
            const storageKey = `simulateTx:${contractKey}:${pattern.function}`;

            // First time: check all requested
            // Returning: only check if already granted
            if (isAppFirstTime || existingGrants.get(storageKey)) {
              keys.add(storageKey);
            }
          });
        }

        // Handle utility simulations
        if (cap.utilities && cap.utilities.scope !== "*") {
          const patterns = cap.utilities.scope as ContractFunctionPattern[];
          patterns.forEach((pattern) => {
            const contractKey =
              pattern.contract === "*" ? "*" : pattern.contract.toString();
            const storageKey = `simulateUtility:${contractKey}:${pattern.function}`;

            if (isAppFirstTime || existingGrants.get(storageKey)) {
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
          const contractKey =
            pattern.contract === "*" ? "*" : pattern.contract.toString();
          const storageKey = `sendTx:${contractKey}:${pattern.function}`;

          if (isAppFirstTime || existingGrants.get(storageKey)) {
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
  }, [manifest.capabilities, existingGrants, isAppFirstTime]);

  const durationDays = Math.floor(duration / 86400000);

  return (
    <>
      {/* App Metadata */}
      <Box sx={{ mb: compact ? 1 : 2, p: compact ? 1 : 1.5, bgcolor: "action.hover", borderRadius: 1 }}>
        <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
          <Typography variant={compact ? "body2" : "subtitle1"} fontWeight={600}>
            {manifest.metadata.name}
          </Typography>
          {manifest.metadata.version && (
            <Chip label={`v${manifest.metadata.version}`} size="small" sx={compact ? { height: 16, fontSize: "0.65rem" } : undefined} />
          )}
        </Box>
        {!compact && manifest.metadata.description && (
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ mt: 0.5, display: "block" }}
          >
            {manifest.metadata.description}
          </Typography>
        )}
      </Box>

      {showAppId &&
        newCapabilityIndices.length < manifest.capabilities.length && (
          <Box
            sx={{
              mb: 1.5,
              p: 1,
              bgcolor: "success.main",
              color: "success.contrastText",
              borderRadius: 1,
            }}
          >
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
                  px: compact ? 1 : 1.5,
                  py: 0.5,
                  minHeight: "unset",
                  "& .MuiAccordionSummary-content": { my: compact ? 0.25 : 0.5, minWidth: 0, overflow: "hidden" },
                }}
              >
                <Box
                  sx={{
                    display: "flex",
                    alignItems: "center",
                    gap: 0.75,
                    width: "100%",
                  }}
                >
                  <Checkbox
                    checked={checkState.checked}
                    indeterminate={checkState.indeterminate}
                    onChange={() => handleToggleCapability(index)}
                    onClick={(e) => e.stopPropagation()}
                    size="small"
                    disabled={isTransactionCapability}
                    sx={{ p: 0 }}
                  />
                  {!compact && (
                    <Box sx={{ fontSize: "1.2rem", display: "flex", alignItems: "center" }}>
                      {getCapabilityIcon(capability.type)}
                    </Box>
                  )}
                  <Box sx={{ flexGrow: 1, display: "flex", alignItems: "center", gap: 0.5, minWidth: 0, overflow: "hidden" }}>
                    <Typography
                      variant={compact ? "caption" : "body2"}
                      fontWeight={isNewCapability && !isTransactionCapability ? 600 : 400}
                      noWrap
                      sx={{ minWidth: 0 }}
                    >
                      {getCapabilityTypeName(capability.type, compact)}
                    </Typography>
                    {isTransactionCapability && (
                      <Chip
                        label={compact ? "approval req." : "Always requires approval"}
                        size="small"
                        color="warning"
                        variant="outlined"
                        sx={{ height: 16, fontSize: "0.6rem", flexShrink: 0 }}
                      />
                    )}
                    {isAlreadyGranted && !isTransactionCapability && (
                      <Chip
                        label="✓"
                        size="small"
                        color="success"
                        variant="outlined"
                        sx={{ height: 16, fontSize: "0.6rem", flexShrink: 0 }}
                      />
                    )}
                  </Box>
                </Box>
              </AccordionSummary>

              <AccordionDetails sx={{ pt: 0, pb: 1, pl: compact ? 1 : { xs: 1, sm: 5 }, pr: compact ? 1 : 1.5 }}>
                {/* Accounts Capability */}
                {isAccountsCapability && (
                  <AccountsCapabilityDetails
                    accounts={accounts}
                    canCreateAuthWit={(capability as AccountsCapability).canCreateAuthWit ?? false}
                    onToggleAccount={handleToggleAccount}
                    onAliasChange={handleAliasChange}
                  />
                )}

                {/* Contracts Capability */}
                {capability.type === "contracts" && (
                  <ContractsCapabilityDetails
                    capability={capability as ContractsCapability}
                    contractPermissions={
                      contractPermissions.get(index) ?? new Map()
                    }
                    contractMetadata={contractMetadata}
                    onPermissionToggle={(
                      addressStr: string,
                      permType: "register" | "metadata",
                    ) =>
                      handleContractPermissionToggle(
                        index,
                        addressStr,
                        permType,
                      )
                    }
                  />
                )}

                {/* Contract Classes Capability */}
                {capability.type === "contractClasses" && (
                  <ContractClassesCapabilityDetails
                    capability={capability as ContractClassesCapability}
                    selectedClasses={
                      contractClassPermissions.get(index) ?? new Set<string>()
                    }
                    onToggleClass={(classIdStr: string) => {
                      setContractClassPermissions(
                        (prev: Map<number, Set<string>>) => {
                          const next = new Map(prev);
                          const classes = next.get(index) ?? new Set<string>();
                          const updated = new Set(classes);
                          if (updated.has(classIdStr)) {
                            updated.delete(classIdStr);
                          } else {
                            updated.add(classIdStr);
                          }
                          next.set(index, updated);
                          return next;
                        },
                      );
                    }}
                  />
                )}

                {/* Simulation Capability */}
                {capability.type === "simulation" && (
                  <SimulationCapabilityDetails
                    capability={capability as SimulationCapability}
                    selectedKeys={
                      simPermissions.get(index) ?? new Set<string>()
                    }
                    contractMetadata={contractMetadata}
                    onTogglePattern={(storageKey: string) =>
                      handleSimPatternToggle(index, storageKey)
                    }
                  />
                )}

                {/* Transaction Capability */}
                {capability.type === "transaction" && (
                  <TransactionCapabilityDetails
                    capability={capability as TransactionCapability}
                    selectedKeys={
                      txPermissions.get(index) ?? new Set<string>()
                    }
                    contractMetadata={contractMetadata}
                    onTogglePattern={(storageKey: string) =>
                      handleTxPatternToggle(index, storageKey)
                    }
                  />
                )}

                {/* Data Capability */}
                {capability.type === "data" && (
                  <DataCapabilityDetails
                    capability={capability as DataCapability}
                  />
                )}
              </AccordionDetails>
            </Accordion>
          );
        })}
      </List>

      {/* Behavior Customization */}
      <Box
        sx={{
          mt: compact ? 1 : 1.5,
          p: compact ? 1 : 1.5,
          border: 1,
          borderColor: "divider",
          borderRadius: 1,
          bgcolor: "action.hover",
        }}
      >
        {!compact && (
          <Typography variant="caption" fontWeight={600} sx={{ display: "block", mb: 1 }}>
            Authorization Settings
          </Typography>
        )}

        <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", mb: compact ? 0.5 : 1 }}>
          {!compact && (
            <Typography variant="caption" color="text.secondary">
              {mode === "permissive" ? "Allow ad-hoc requests" : "Strict mode (only declared ops)"}
            </Typography>
          )}
          <Box sx={{ display: "flex", alignItems: "center", gap: 0.5, ml: compact ? 0 : "auto" }}>
            <Typography
              variant="caption"
              color={mode === "permissive" ? "primary.main" : "text.secondary"}
              fontWeight={mode === "permissive" ? 600 : 400}
            >
              Permissive
            </Typography>
            <Switch
              size="small"
              checked={mode === "strict"}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                setMode(e.target.checked ? "strict" : "permissive")
              }
              color="warning"
            />
            <Typography
              variant="caption"
              color={mode === "strict" ? "warning.main" : "text.secondary"}
              fontWeight={mode === "strict" ? 600 : 400}
            >
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
          InputProps={{ sx: { fontSize: compact ? "0.75rem" : "0.875rem" } }}
          InputLabelProps={{ sx: { fontSize: compact ? "0.75rem" : "0.875rem" } }}
        />
      </Box>

      {!compact && (
        <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: "block", fontStyle: "italic" }}>
          Permissions persist for {durationDays} days and can be revoked from settings.
        </Typography>
      )}
    </>
  );
}
