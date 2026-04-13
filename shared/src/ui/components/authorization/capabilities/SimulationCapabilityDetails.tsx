import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import Checkbox from "@mui/material/Checkbox";
import FormControlLabel from "@mui/material/FormControlLabel";
import type { ContractFunctionPattern } from "@aztec/aztec.js/wallet";
import type { SimulationCapability } from "./types";

interface SimulationCapabilityDetailsProps {
  capability: SimulationCapability;
  selectedKeys: Set<string>;
  contractMetadata: Map<string, string>;
  onTogglePattern: (storageKey: string) => void;
}

function PatternCards({
  patterns,
  prefix,
  selectedKeys,
  contractMetadata,
  onTogglePattern,
}: {
  patterns: ContractFunctionPattern[];
  prefix: "simulateTx" | "simulateUtility";
  selectedKeys: Set<string>;
  contractMetadata: Map<string, string>;
  onTogglePattern: (storageKey: string) => void;
}) {
  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 0.5 }}>
      {patterns.map((pattern, idx) => {
        const contractKey = pattern.contract === "*" ? "*" : pattern.contract.toString();
        const addressStr = contractKey;
        const rawName = contractMetadata.get(addressStr);
        const name = rawName && !rawName.includes("...") ? rawName : undefined;
        const shortAddr =
          contractKey === "*" ? null : `${addressStr.slice(0, 10)}...${addressStr.slice(-8)}`;
        const funcName = pattern.function === "*" ? "any function" : pattern.function;
        const storageKey = `${prefix}:${contractKey}:${pattern.function}`;

        return (
          <Box
            key={idx}
            sx={{
              p: 0.75,
              border: 1,
              borderColor: "divider",
              borderRadius: 0.5,
              bgcolor: "background.paper",
            }}
          >
            {/* Contract identity */}
            <Box sx={{ mb: 0.25 }}>
              {contractKey === "*" ? (
                <Typography variant="caption" color="warning.main">
                  ⚠️ Any contract
                </Typography>
              ) : name ? (
                <>
                  <Typography variant="caption" fontWeight={600} sx={{ display: "block" }}>
                    {name}
                  </Typography>
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    sx={{ fontFamily: "monospace", fontSize: "0.65rem" }}
                  >
                    {shortAddr}
                  </Typography>
                </>
              ) : (
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{ fontFamily: "monospace" }}
                >
                  {shortAddr}
                </Typography>
              )}
            </Box>
            {/* Function checkbox */}
            <FormControlLabel
              control={
                <Checkbox
                  size="small"
                  checked={selectedKeys.has(storageKey)}
                  onChange={() => onTogglePattern(storageKey)}
                  sx={{ p: 0.25 }}
                />
              }
              label={
                <Typography variant="caption" sx={{ fontFamily: "monospace", fontSize: "0.7rem" }}>
                  {funcName}
                </Typography>
              }
              sx={{ m: 0 }}
            />
          </Box>
        );
      })}
    </Box>
  );
}

export function SimulationCapabilityDetails({
  capability,
  selectedKeys,
  contractMetadata,
  onTogglePattern,
}: SimulationCapabilityDetailsProps) {
  return (
    <Box>
      {/* Transaction Simulations Section */}
      {capability.transactions && (
        <Box sx={{ mb: 1 }}>
          <Typography variant="caption" sx={{ fontWeight: 600, display: "block", mb: 0.5 }}>
            Transaction Simulations (simulateTx)
          </Typography>
          {capability.transactions.scope === "*" ? (
            <Typography variant="caption" color="warning.main">
              ⚠️ Any transaction (wildcard)
            </Typography>
          ) : (
            <PatternCards
              patterns={capability.transactions.scope as ContractFunctionPattern[]}
              prefix="simulateTx"
              selectedKeys={selectedKeys}
              contractMetadata={contractMetadata}
              onTogglePattern={onTogglePattern}
            />
          )}
        </Box>
      )}

      {/* Utility Simulations Section */}
      {capability.utilities && (
        <Box>
          <Typography variant="caption" sx={{ fontWeight: 600, display: "block", mb: 0.5, mt: 1 }}>
            Utility Simulations (simulateUtility)
          </Typography>
          {capability.utilities.scope === "*" ? (
            <Typography variant="caption" color="warning.main">
              ⚠️ Any utility function (wildcard)
            </Typography>
          ) : (
            <PatternCards
              patterns={capability.utilities.scope as ContractFunctionPattern[]}
              prefix="simulateUtility"
              selectedKeys={selectedKeys}
              contractMetadata={contractMetadata}
              onTogglePattern={onTogglePattern}
            />
          )}
        </Box>
      )}
    </Box>
  );
}
