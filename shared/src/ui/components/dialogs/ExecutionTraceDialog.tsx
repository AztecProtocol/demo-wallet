import Dialog from "@mui/material/Dialog";
import DialogTitle from "@mui/material/DialogTitle";
import DialogContent from "@mui/material/DialogContent";
import DialogActions from "@mui/material/DialogActions";
import Button from "@mui/material/Button";
import IconButton from "@mui/material/IconButton";
import CloseIcon from "@mui/icons-material/Close";
import Alert from "@mui/material/Alert";
import { useTheme } from "@mui/material/styles";
import useMediaQuery from "@mui/material/useMediaQuery";
import { AztecAddress } from "@aztec/stdlib/aztec-address";
import { ExecutionTraceDisplay } from "../shared/ExecutionTraceDisplay";
import type { DecodedExecutionTrace } from "../../../wallet/decoding/tx-callstack-decoder";
import type { ExecutionStats } from "../shared/PhaseTimeline";

interface ExecutionTraceDialogProps {
  open: boolean;
  onClose: () => void;
  trace: DecodedExecutionTrace | null;
  stats?: ExecutionStats;
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
  const theme = useTheme();
  const isSmall = useMediaQuery(theme.breakpoints.down("md"));

  if (!trace) return null;

  const isFromZero =
    from === "NO_FROM" ||
    (from && from.startsWith("0x") && AztecAddress.fromStringUnsafe(from).equals(AztecAddress.ZERO));
  const hasEmbeddedFeePayer = !!embeddedPaymentMethodFeePayer;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      fullScreen={isSmall}
      maxWidth="md"
      fullWidth
      PaperProps={{
        sx: isSmall ? undefined : { maxHeight: "80vh" },
      }}
    >
      <DialogTitle
        sx={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          py: 1,
          px: { xs: 1.5, sm: 3 },
        }}
      >
        Execution Trace
        <IconButton aria-label="close" onClick={onClose} sx={{ color: (t) => t.palette.grey[500] }}>
          <CloseIcon />
        </IconButton>
      </DialogTitle>
      <DialogContent dividers sx={{ px: { xs: 1, sm: 3 }, overflow: "auto", minWidth: 0 }}>
        {isFromZero && (
          <Alert severity="info" sx={{ mb: 1 }}>
            This transaction uses an external entrypoint and does not execute from any of your
            accounts.
          </Alert>
        )}
        {hasEmbeddedFeePayer && (
          <Alert severity="success" sx={{ mb: 1 }}>
            The app is providing the fee payment method for this transaction.
          </Alert>
        )}
        <ExecutionTraceDisplay
          trace={trace}
          accordionBgColor="background.default"
          stats={stats}
          compact={isSmall}
        />
      </DialogContent>
      <DialogActions sx={{ px: { xs: 1.5, sm: 3 }, py: 1 }}>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}
