import Typography from "@mui/material/Typography";
import Box from "@mui/material/Box";
import Card from "@mui/material/Card";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import CheckIcon from "@mui/icons-material/Check";

import IconButton from "@mui/material/IconButton";
import Switch from "@mui/material/Switch";
import Tooltip from "@mui/material/Tooltip";
import { useState } from "react";
import QrCode from "@mui/icons-material/QrCode";
import { QRDialog } from "../../../dialogs/QRDialog";
import { type Aliased } from "@aztec/aztec.js/wallet";
import { type AztecAddress } from "@aztec/aztec.js/addresses";

interface ContactBoxProps {
  contact: Aliased<AztecAddress>;
  QRButton?: boolean;
  privateChannel?: boolean;
  onPrivateChannelChange?: (enabled: boolean) => void;
}

export function ContactBox({
  contact,
  QRButton = false,
  privateChannel = false,
  onPrivateChannelChange,
}: ContactBoxProps) {
  const [openQR, setOpenQR] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    if (contact.item) {
      await navigator.clipboard.writeText(contact.item.toString());
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  // Remove "senders:" prefix from alias if present
  const displayAlias = contact.alias.startsWith("senders:")
    ? contact.alias.substring("senders:".length)
    : contact.alias;

  return (
    <Card
      sx={{
        width: "100%",
        boxShadow: 2,
        transition: "box-shadow 0.2s, transform 0.2s",
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
          <Typography
            variant="subtitle2"
            sx={{
              fontWeight: 600,
              mb: 0.5,
            }}
          >
            {displayAlias}
          </Typography>
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
            {contact.item ? contact.item.toString() : "Uninitialized"}
          </Typography>
        </Box>
        {onPrivateChannelChange && contact.item && (
          <Tooltip title="Private channel (interactive handshake)">
            <Switch
              size="small"
              checked={privateChannel}
              onChange={(e) => onPrivateChannelChange(e.target.checked)}
            />
          </Tooltip>
        )}
        {contact.item && (
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
        {QRButton && contact.item && (
          <IconButton size="small" onClick={() => setOpenQR(true)}>
            <QrCode fontSize="small" />
          </IconButton>
        )}
      </Box>
      {openQR && contact.item && (
        <QRDialog
          open={openQR}
          onClose={() => setOpenQR(false)}
          address={contact.item!.toString()}
        />
      )}
    </Card>
  );
}
