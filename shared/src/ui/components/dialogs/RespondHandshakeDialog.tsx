import { useContext, useState } from "react";
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
import CircularProgress from "@mui/material/CircularProgress";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import CheckIcon from "@mui/icons-material/Check";
import { WalletContext } from "../../renderer";

interface RespondHandshakeDialogProps {
  open: boolean;
  onClose: () => void;
}

/**
 * Recipient side of an interactive handshake. The user pastes an incoming request blob a sender
 * shared with them; `respondToInteractiveHandshake` gates on consent (the existing authorization
 * dialog), signs, and returns a signature blob shown here (QR + copyable) to hand back to the
 * sender. No worker push channel is involved — the whole exchange is UI-initiated.
 */
export function RespondHandshakeDialog({ open, onClose }: RespondHandshakeDialogProps) {
  const { walletAPI } = useContext(WalletContext);
  const [requestBlob, setRequestBlob] = useState("");
  const [signatureBlob, setSignatureBlob] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const reset = () => {
    setRequestBlob("");
    setSignatureBlob("");
    setError(null);
    setBusy(false);
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const handleRespond = async () => {
    setBusy(true);
    setError(null);
    try {
      // Consent is requested inside the wallet (the existing authorization dialog); this resolves
      // once the user approves and the signature is produced.
      const signature = await walletAPI.respondToInteractiveHandshake(requestBlob.trim());
      setSignatureBlob(signature);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleCopy = async () => {
    await navigator.clipboard.writeText(signatureBlob);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="sm" fullWidth>
      <DialogTitle>Respond to interactive handshake</DialogTitle>
      <DialogContent>
        <Box sx={{ display: "flex", flexDirection: "column", gap: 2, pt: 1 }}>
          {!signatureBlob ? (
            <>
              <Typography variant="body2">
                Paste the interactive-handshake request a sender shared with you. You&apos;ll be
                asked to approve opening the channel, then get a signature blob to send back.
              </Typography>
              <TextField
                label="Handshake request blob"
                value={requestBlob}
                onChange={(e) => setRequestBlob(e.target.value)}
                placeholder="Paste the sender's request here"
                fullWidth
                multiline
                minRows={3}
                disabled={busy}
              />
              {error && <Alert severity="error">{error}</Alert>}
            </>
          ) : (
            <>
              <Typography variant="body2">
                Channel authorized. Send this signature back to the sender (scan the QR or copy the
                blob) to complete the handshake.
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
                  value={signatureBlob}
                  viewBox={`0 0 256 256`}
                />
              </Box>
              <Button
                startIcon={copied ? <CheckIcon /> : <ContentCopyIcon />}
                onClick={handleCopy}
              >
                {copied ? "Copied" : "Copy signature"}
              </Button>
            </>
          )}
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={handleClose}>{signatureBlob ? "Done" : "Cancel"}</Button>
        {!signatureBlob && (
          <Button
            onClick={handleRespond}
            variant="contained"
            disabled={!requestBlob.trim() || busy}
            startIcon={busy ? <CircularProgress size={16} /> : undefined}
          >
            Respond
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
