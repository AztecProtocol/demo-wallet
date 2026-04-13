import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import type { AztecAddress } from "@aztec/aztec.js/addresses";
import type { DataCapability } from "./types";

interface DataCapabilityDetailsProps {
  capability: DataCapability;
}

export function DataCapabilityDetails({ capability }: DataCapabilityDetailsProps) {
  return (
    <Box>
      {capability.addressBook && (
        <Typography variant="caption" gutterBottom sx={{ display: "block" }}>
          • Access to address book
        </Typography>
      )}
      {capability.privateEvents && (
        <Typography variant="caption" sx={{ display: "block" }}>
          • Private events from{" "}
          {capability.privateEvents.contracts === "*"
            ? "all contracts"
            : `${(capability.privateEvents.contracts as AztecAddress[]).length} contract(s)`}
        </Typography>
      )}
    </Box>
  );
}
