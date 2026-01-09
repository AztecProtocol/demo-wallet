import { useState } from "react";
import Dialog from "@mui/material/Dialog";
import DialogTitle from "@mui/material/DialogTitle";
import DialogContent from "@mui/material/DialogContent";
import DialogActions from "@mui/material/DialogActions";
import Button from "@mui/material/Button";
import Typography from "@mui/material/Typography";
import Box from "@mui/material/Box";
import Alert from "@mui/material/Alert";
import Checkbox from "@mui/material/Checkbox";
import FormControlLabel from "@mui/material/FormControlLabel";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import CircularProgress from "@mui/material/CircularProgress";

export interface ProofDebugExportRequest {
  id: string;
  errorMessage: string;
  interactionTitle: string;
}

interface ProofDebugExportDialogProps {
  request: ProofDebugExportRequest;
  onExport: () => Promise<void>;
  onCancel: () => void;
}

export function ProofDebugExportDialog({
  request,
  onExport,
  onCancel,
}: ProofDebugExportDialogProps) {
  const [acknowledged, setAcknowledged] = useState(false);
  const [isExporting, setIsExporting] = useState(false);

  const handleExport = async () => {
    setIsExporting(true);
    try {
      await onExport();
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <Dialog open={true} maxWidth="sm" fullWidth>
      <DialogTitle>
        <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
          <WarningAmberIcon color="warning" />
          <span>Proving Failed - Export Debug Data?</span>
        </Box>
      </DialogTitle>
      <DialogContent>
        <Alert severity="error" sx={{ mb: 2 }}>
          <Typography variant="body2">
            <strong>Transaction:</strong> {request.interactionTitle}
          </Typography>
          <Typography variant="body2" sx={{ mt: 1 }}>
            <strong>Error:</strong> {request.errorMessage}
          </Typography>
        </Alert>

        <Typography variant="body1" gutterBottom>
          The proving process failed. You can export debug data to help the
          development team investigate this issue.
        </Typography>

        <Alert severity="warning" sx={{ my: 2 }}>
          <Typography variant="body2" fontWeight="bold" gutterBottom>
            Privacy Warning
          </Typography>
          <Typography variant="body2">
            The exported file contains <strong>sensitive information</strong>{" "}
            including:
          </Typography>
          <Box component="ul" sx={{ mt: 1, mb: 0, pl: 2 }}>
            <li>
              <Typography variant="body2">
                Private execution witnesses (may reveal transaction details)
              </Typography>
            </li>
            <li>
              <Typography variant="body2">
                Circuit bytecode and verification keys
              </Typography>
            </li>
            <li>
              <Typography variant="body2">
                Function names and execution flow
              </Typography>
            </li>
          </Box>
        </Alert>

        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Only share this file with trusted parties (e.g., the Aztec development
          team) for debugging purposes.
        </Typography>

        <FormControlLabel
          control={
            <Checkbox
              checked={acknowledged}
              onChange={(e) => setAcknowledged(e.target.checked)}
            />
          }
          label={
            <Typography variant="body2">
              I understand this file contains sensitive data and I consent to
              exporting it
            </Typography>
          }
        />
      </DialogContent>

      <DialogActions>
        <Button onClick={onCancel} disabled={isExporting}>
          Cancel
        </Button>
        <Button
          onClick={handleExport}
          color="primary"
          variant="contained"
          disabled={!acknowledged || isExporting}
          startIcon={isExporting ? <CircularProgress size={16} /> : null}
        >
          {isExporting ? "Exporting..." : "Export Debug Data"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
