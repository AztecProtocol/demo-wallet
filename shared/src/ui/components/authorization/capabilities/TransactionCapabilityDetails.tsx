import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import Checkbox from "@mui/material/Checkbox";
import FormControlLabel from "@mui/material/FormControlLabel";
import type { ContractFunctionPattern } from "@aztec/aztec.js/wallet";
import type { TransactionCapability } from "./types";

interface TransactionCapabilityDetailsProps {
  capability: TransactionCapability;
  selectedKeys: Set<string>;
  contractMetadata: Map<string, string>;
  onTogglePattern: (storageKey: string) => void;
}

export function TransactionCapabilityDetails({
  capability,
  selectedKeys,
  contractMetadata,
  onTogglePattern,
}: TransactionCapabilityDetailsProps) {
  if (capability.scope === "*") {
    return (
      <Typography variant="caption" color="warning.main">
        ⚠️ Any transaction (wildcard)
      </Typography>
    );
  }

  const patterns = capability.scope as ContractFunctionPattern[];

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
        const storageKey = `sendTx:${contractKey}:${pattern.function}`;

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
