import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import Checkbox from "@mui/material/Checkbox";
import FormControlLabel from "@mui/material/FormControlLabel";
import type { ContractClassesCapability } from "./types";

interface ContractClassesCapabilityDetailsProps {
  capability: ContractClassesCapability;
  selectedClasses: Set<string>;
  onToggleClass: (classIdStr: string) => void;
}

export function ContractClassesCapabilityDetails({
  capability,
  selectedClasses,
  onToggleClass,
}: ContractClassesCapabilityDetailsProps) {
  if (capability.classes === "*") {
    return (
      <Typography variant="caption" color="warning.main">
        ⚠️ Any contract class (wildcard)
      </Typography>
    );
  }

  return (
    <Box>
      {(capability.classes as { toString(): string }[]).map((classId) => {
        const classIdStr = classId.toString();
        const shortClassId = `${classIdStr.slice(0, 12)}...${classIdStr.slice(-8)}`;
        const isSelected = selectedClasses.has(classIdStr);

        return (
          <Box
            key={classIdStr}
            sx={{
              mb: 0.5,
              display: "flex",
              alignItems: "center",
              gap: 0.5,
              flexWrap: "wrap",
            }}
          >
            <FormControlLabel
              control={
                <Checkbox
                  size="small"
                  checked={isSelected}
                  onChange={() => onToggleClass(classIdStr)}
                />
              }
              label={
                <Typography
                  variant="caption"
                  sx={{
                    fontFamily: "monospace",
                    fontSize: "0.7rem",
                  }}
                >
                  {shortClassId}
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
