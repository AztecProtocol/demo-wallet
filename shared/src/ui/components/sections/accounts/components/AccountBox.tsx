import Typography from "@mui/material/Typography";
import Box from "@mui/material/Box";
import Card from "@mui/material/Card";
import Chip from "@mui/material/Chip";
import Tooltip from "@mui/material/Tooltip";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import CheckIcon from "@mui/icons-material/Check";
import RocketLaunchIcon from "@mui/icons-material/RocketLaunch";

import IconButton from "@mui/material/IconButton";
import { useState } from "react";
import QrCode from "@mui/icons-material/QrCode";
import { QRDialog } from "../../../dialogs/QRDialog";
import { type Aliased } from "@aztec/aztec.js/wallet";
import { type AztecAddress } from "@aztec/aztec.js/addresses";

interface AccountBoxProps {
  account: Aliased<AztecAddress> & { type: string; deployed: boolean };
  QRButton?: boolean;
  onDeploy?: (address: AztecAddress) => void;
}

export function AccountBox({ account, QRButton = false, onDeploy }: AccountBoxProps) {
  const [openQR, setOpenQR] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    if (account.item) {
      await navigator.clipboard.writeText(account.item.toString());
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <Card
      sx={{
        width: "100%",
        boxShadow: 2,
        transition: "box-shadow 0.2s, transform 0.2s",
        opacity: account.deployed ? 1 : 0.55,
        "&:hover": {
          boxShadow: 4,
          transform: "translateY(-2px)",
        },
      }}
    >
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          padding: "1rem",
          gap: 1,
        }}
      >
        <Box sx={{ flexGrow: 1, minWidth: 0 }}>
          <Box sx={{ display: "flex", alignItems: "center", gap: 1, mb: 0.5 }}>
            <Typography
              variant="subtitle2"
              sx={{
                fontWeight: 600,
              }}
            >
              {account.alias}
            </Typography>
            {!account.deployed && (
              <Chip
                label="Not deployed"
                size="small"
                variant="outlined"
                sx={{ fontSize: "0.65rem", height: 20 }}
              />
            )}
          </Box>
          <Typography
            variant="body2"
            sx={{
              fontFamily: "monospace",
              fontSize: "0.75rem",
              color: "text.secondary",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {account.item ? account.item.toString() : "Uninitialized"}
          </Typography>
          <Typography
            variant="caption"
            sx={{
              color: "text.secondary",
              fontSize: "0.7rem",
            }}
          >
            {account.type}
          </Typography>
        </Box>
        {!account.deployed && onDeploy && (
          <Tooltip title="Deploy account">
            <IconButton size="small" onClick={() => onDeploy(account.item)} color="primary">
              <RocketLaunchIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        )}
        {account.item && (
          <IconButton
            size="small"
            onClick={handleCopy}
            sx={{
              color: copied ? "success.main" : "action.active",
            }}
          >
            {copied ? <CheckIcon fontSize="small" /> : <ContentCopyIcon fontSize="small" />}
          </IconButton>
        )}
        {QRButton && account.item && (
          <IconButton size="small" onClick={() => setOpenQR(true)}>
            <QrCode fontSize="small" />
          </IconButton>
        )}
      </Box>
      {openQR && account.item && (
        <QRDialog
          open={openQR}
          onClose={() => setOpenQR(false)}
          address={account.item!.toString()}
        />
      )}
    </Card>
  );
}
