import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import Checkbox from "@mui/material/Checkbox";
import FormControlLabel from "@mui/material/FormControlLabel";
import TextField from "@mui/material/TextField";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import type { AccountSelection } from "./types";

interface AccountsCapabilityDetailsProps {
  accounts: AccountSelection[];
  canCreateAuthWit: boolean;
  onToggleAccount: (index: number) => void;
  onAliasChange: (index: number, alias: string) => void;
}

export function AccountsCapabilityDetails({
  accounts,
  canCreateAuthWit,
  onToggleAccount,
  onAliasChange,
}: AccountsCapabilityDetailsProps) {
  return (
    <Box>
      {canCreateAuthWit && (
        <Box
          sx={{ display: "flex", alignItems: "center", gap: 0.5, mb: 1, color: "text.secondary" }}
        >
          <InfoOutlinedIcon sx={{ fontSize: "1rem" }} />
          <Typography variant="caption">
            This app may request auth witnesses (each request will require approval)
          </Typography>
        </Box>
      )}
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
                onChange={() => onToggleAccount(accIndex)}
              />
            }
            label={
              <Box>
                <Typography variant="body2" fontWeight={account.selected ? 600 : 400}>
                  {account.originalAlias}
                </Typography>
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{
                    fontFamily: "monospace",
                    fontSize: "0.7rem",
                  }}
                >
                  {account.address.slice(0, 16)}...
                  {account.address.slice(-8)}
                </Typography>
              </Box>
            }
            sx={{ m: 0 }}
          />
          {account.selected && (
            <Box sx={{ pl: 3.5, mt: 0.5 }}>
              <TextField
                size="small"
                value={account.alias}
                onChange={(e) => onAliasChange(accIndex, e.target.value)}
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
  );
}
