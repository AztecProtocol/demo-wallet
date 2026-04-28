/**
 * PIN dialog — prompts the user for a short passphrase (PIN) used to
 * encrypt/decrypt account secrets.
 *
 * Two modes:
 * - "set": User sets a new PIN (first time)
 * - "enter": User enters existing PIN (after reload, or in iframe context)
 *
 * Renders as a full-viewport centered card. Dark styling is applied inline
 * so it looks correct even without a ThemeProvider ancestor (host shells
 * may render this before the Root/ThemeProvider mounts).
 */

import { useState, useCallback } from "react";
import { Box, Button, TextField, Typography } from "@mui/material";

export interface PinDialogProps {
  mode: "set" | "enter";
  error?: string | null;
  onSubmit: (pin: string) => void;
}

const textFieldSx = {
  "& .MuiOutlinedInput-root": {
    color: "#fff",
    fontFamily: "monospace",
    "& fieldset": { borderColor: "#444" },
    "&:hover fieldset": { borderColor: "#666" },
    "&.Mui-focused fieldset": { borderColor: "#715ec2" },
  },
  "& .MuiInputLabel-root": {
    color: "#888",
    fontFamily: "monospace",
    "&.Mui-focused": { color: "#715ec2" },
  },
};

export function PinDialog({ mode, error, onSubmit }: PinDialogProps) {
  const [pin, setPin] = useState("");
  const [confirm, setConfirm] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);

  const handleSubmit = useCallback(() => {
    if (pin.length < 6) {
      setLocalError("PIN must be at least 6 characters");
      return;
    }
    if (mode === "set" && pin !== confirm) {
      setLocalError("PINs do not match");
      return;
    }
    setLocalError(null);
    onSubmit(pin);
  }, [pin, confirm, mode, onSubmit]);

  const displayError = error ?? localError;

  return (
    <Box
      sx={{
        position: "fixed",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        bgcolor: "#121212",
        p: 3,
      }}
    >
      <Box
        sx={{
          width: "100%",
          maxWidth: 360,
          bgcolor: "#1e1e1e",
          borderRadius: 2,
          p: 3,
          display: "flex",
          flexDirection: "column",
          gap: 2.5,
        }}
      >
        <Typography
          variant="h6"
          sx={{ color: "#fff", fontFamily: "monospace", textAlign: "center" }}
        >
          {mode === "set" ? "Set wallet PIN" : "Enter wallet PIN"}
        </Typography>

        <Typography
          variant="body2"
          sx={{ color: "#999", fontFamily: "monospace", textAlign: "center" }}
        >
          {mode === "set"
            ? "This PIN encrypts your account secrets. You'll need it when using the wallet from a dApp."
            : "Enter your PIN to decrypt your wallet accounts."}
        </Typography>

        <TextField
          autoFocus
          label="PIN"
          type="password"
          value={pin}
          onChange={(e) => setPin(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && e.isTrusted) {
              if (mode === "set" && !confirm) return;
              handleSubmit();
            }
          }}
          inputProps={{ minLength: 6, maxLength: 32 }}
          fullWidth
          size="small"
          sx={textFieldSx}
        />

        {mode === "set" && (
          <TextField
            label="Confirm PIN"
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && e.isTrusted) handleSubmit();
            }}
            inputProps={{ minLength: 6, maxLength: 32 }}
            fullWidth
            size="small"
            sx={textFieldSx}
          />
        )}

        {displayError && (
          <Typography
            variant="body2"
            sx={{ color: "#f44336", fontFamily: "monospace", textAlign: "center" }}
          >
            {displayError}
          </Typography>
        )}

        <Button
          onClick={handleSubmit}
          variant="contained"
          disabled={pin.length < 6}
          fullWidth
          sx={{
            bgcolor: "#715ec2",
            fontFamily: "monospace",
            textTransform: "none",
            "&:hover": { bgcolor: "#5e4da6" },
            "&.Mui-disabled": { bgcolor: "#333", color: "#666" },
          }}
        >
          {mode === "set" ? "Set PIN" : "Unlock"}
        </Button>
      </Box>
    </Box>
  );
}
