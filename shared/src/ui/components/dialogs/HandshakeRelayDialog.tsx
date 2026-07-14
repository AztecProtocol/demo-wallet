import { useEffect, useState } from "react";
import QRCode from "react-qr-code";
import Dialog from "@mui/material/Dialog";
import DialogTitle from "@mui/material/DialogTitle";
import DialogContent from "@mui/material/DialogContent";
import DialogActions from "@mui/material/DialogActions";
import Button from "@mui/material/Button";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import TextField from "@mui/material/TextField";
import Alert from "@mui/material/Alert";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import CheckIcon from "@mui/icons-material/Check";
import type { HandshakeRelayRequest, HandshakeRelayResponse } from "../../../wallet/types/handshake";

// Manual relays are user-paced, so this is not a hard deadline: when it elapses we surface a retry
// affordance but keep the relay open so a late paste still completes the pending send.
const RELAY_TIMEOUT_MS = 120_000;

interface HandshakeRelayDialogProps {
  request: HandshakeRelayRequest;
  onResolve: (response: HandshakeRelayResponse) => void;
}

/**
 * Sender side of an interactive handshake. A private send is paused inside PXE's
 * `resolveCustomRequest` hook until the recipient authorizes the channel. This dialog shows the
 * request envelope (QR + copyable blob) for the user to hand to the recipient's wallet, and takes
 * the recipient's signature blob back. Submitting resolves the pending send; cancelling fails it.
 */
export function HandshakeRelayDialog({ request, onResolve }: HandshakeRelayDialogProps) {
  const [signatureBlob, setSignatureBlob] = useState("");
  const [copied, setCopied] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setTimedOut(false);
    const timer = setTimeout(() => setTimedOut(true), RELAY_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [attempt, request.id]);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(request.requestBlob);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleSubmit = () => {
    const trimmed = signatureBlob.trim();
    if (!trimmed) {
      setError("Paste the recipient's signature blob first.");
      return;
    }
    onResolve({ id: request.id, approved: true, signatureBlob: trimmed });
  };

  const handleCancel = () => onResolve({ id: request.id, approved: false });

  const handleRetry = () => {
    setSignatureBlob("");
    setError(null);
    setAttempt((a) => a + 1);
  };

  return (
    <Dialog open maxWidth="sm" fullWidth>
      <DialogTitle>Relay interactive handshake</DialogTitle>
      <DialogContent>
        <Box sx={{ display: "flex", flexDirection: "column", gap: 2, pt: 1 }}>
          <Typography variant="body2">
            This private send needs the recipient to authorize a message channel. Show this request
            to the recipient&apos;s wallet (scan the QR or copy the blob), then paste the signature
            they return below.
          </Typography>

          <Box
            sx={{
              display: "flex",
              justifyContent: "center",
              bgcolor: "#fff",
              p: 2,
              borderRadius: 1,
            }}
          >
            <QRCode
              size={256}
              style={{ height: "auto", maxWidth: "60vw", width: "100%" }}
              value={request.requestBlob}
              viewBox={`0 0 256 256`}
            />
          </Box>

          <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
            <Typography variant="caption" sx={{ flexGrow: 1, color: "text.secondary" }}>
              Handshake request blob
            </Typography>
            <Button
              size="small"
              startIcon={copied ? <CheckIcon /> : <ContentCopyIcon />}
              onClick={handleCopy}
            >
              {copied ? "Copied" : "Copy request"}
            </Button>
          </Box>

          {timedOut && (
            <Alert severity="warning">
              Still waiting for the recipient. Keep waiting and paste their reply when it arrives,
              retry, or cancel this send.
            </Alert>
          )}

          <TextField
            label="Recipient signature blob"
            value={signatureBlob}
            onChange={(e) => setSignatureBlob(e.target.value)}
            placeholder="Paste the recipient's signature here"
            fullWidth
            multiline
            minRows={3}
            error={!!error}
            helperText={error ?? undefined}
          />
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={handleCancel} color="error">
          Cancel send
        </Button>
        {timedOut && <Button onClick={handleRetry}>Retry</Button>}
        <Button onClick={handleSubmit} variant="contained" disabled={!signatureBlob.trim()}>
          Submit signature
        </Button>
      </DialogActions>
    </Dialog>
  );
}
