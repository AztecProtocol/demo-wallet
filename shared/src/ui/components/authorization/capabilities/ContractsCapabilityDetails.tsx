import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import Chip from "@mui/material/Chip";
import type { AztecAddress } from "@aztec-labs/aztec.js/addresses";
import type { ContractsCapability } from "./types";

interface ContractsCapabilityDetailsProps {
  capability: ContractsCapability;
  contractPermissions: Map<string, { register: boolean; metadata: boolean }>;
  contractMetadata: Map<string, string>;
  onPermissionToggle: (addressStr: string, permType: "register" | "metadata") => void;
}

export function ContractsCapabilityDetails({
  capability,
  contractPermissions,
  contractMetadata,
  onPermissionToggle,
}: ContractsCapabilityDetailsProps) {
  if (capability.contracts === "*") {
    return (
      <Typography variant="caption" color="warning.main">
        ⚠️ All contracts (wildcard)
      </Typography>
    );
  }

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 0.5 }}>
      {(capability.contracts as AztecAddress[]).map((address) => {
        const addressStr = address.toString();
        const perms = contractPermissions.get(addressStr);
        const rawName = contractMetadata.get(addressStr);
        // Don't show name if it's a shortened address fallback (contains "...")
        const name = rawName && !rawName.includes("...") ? rawName : undefined;
        const shortAddr = `${addressStr.slice(0, 10)}...${addressStr.slice(-8)}`;

        return (
          <Box
            key={addressStr}
            sx={{
              p: 0.75,
              border: 1,
              borderColor: "divider",
              borderRadius: 0.5,
              bgcolor: "background.paper",
            }}
          >
            {/* Contract identity */}
            <Box sx={{ mb: 0.5 }}>
              {name ? (
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
            {/* Operations */}
            {(capability.canRegister || capability.canGetMetadata) && (
              <Box sx={{ display: "flex", gap: 0.5 }}>
                {capability.canRegister && (
                  <Chip
                    label="Register"
                    size="small"
                    color={perms?.register ? "primary" : "default"}
                    onClick={() => onPermissionToggle(addressStr, "register")}
                    sx={{ cursor: "pointer", height: 18, fontSize: "0.65rem" }}
                  />
                )}
                {capability.canGetMetadata && (
                  <Chip
                    label="Metadata"
                    size="small"
                    color={perms?.metadata ? "primary" : "default"}
                    onClick={() => onPermissionToggle(addressStr, "metadata")}
                    sx={{ cursor: "pointer", height: 18, fontSize: "0.65rem" }}
                  />
                )}
              </Box>
            )}
          </Box>
        );
      })}
    </Box>
  );
}
