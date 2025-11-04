import Dialog from "@mui/material/Dialog";
import DialogTitle from "@mui/material/DialogTitle";
import DialogContent from "@mui/material/DialogContent";
import DialogActions from "@mui/material/DialogActions";
import Button from "@mui/material/Button";
import IconButton from "@mui/material/IconButton";
import CloseIcon from "@mui/icons-material/Close";
import Alert from "@mui/material/Alert";
import { AztecAddress } from "@aztec/stdlib/aztec-address";
import { ExecutionTraceDisplay } from "../shared/ExecutionTraceDisplay";
import type { DecodedExecutionTrace } from "../../../wallet/decoding/tx-callstack-decoder";

interface ExecutionTraceDialogProps {
  open: boolean;
  onClose: () => void;
  trace: DecodedExecutionTrace | null;
  stats?: any;
  from?: string | null;
  embeddedPaymentMethodFeePayer?: string | null;
}

export function ExecutionTraceDialog({
  open,
  onClose,
  trace,
  stats,
  from,
  embeddedPaymentMethodFeePayer,
}: ExecutionTraceDialogProps) {
  if (!trace) return null;

  const isFromZero = from && AztecAddress.fromString(from).equals(AztecAddress.ZERO);
  const hasEmbeddedFeePayer = !!embeddedPaymentMethodFeePayer;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="md"
      fullWidth
      PaperProps={{
        sx: {
          maxHeight: "80vh",
        },
      }}
    >
      <DialogTitle
        sx={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        Execution Trace
        <IconButton
          aria-label="close"
          onClick={onClose}
          sx={{
            color: (theme) => theme.palette.grey[500],
          }}
        >
          <CloseIcon />
        </IconButton>
      </DialogTitle>
      <DialogContent dividers>
        {isFromZero && (
          <Alert severity="info" sx={{ mb: 2 }}>
            This request uses the MulticallEntrypoint and does not execute from any of your accounts.
          </Alert>
        )}
        {hasEmbeddedFeePayer && (
          <Alert severity="success" sx={{ mb: 2 }}>
            The app is providing the fee payment method for this transaction.
          </Alert>
        )}
        <ExecutionTraceDisplay
          trace={trace}
          accordionBgColor="background.default"
          stats={stats}
        />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}
