import { useState } from "react";
import {
  Box,
  Button,
  TextField,
  Typography,
  Stepper,
  Step,
  StepLabel,
} from "@mui/material";
import { PortClient } from "../../src/ipc/port-client";

const steps = ["Welcome", "Set Password", "Done"];

export function Onboarding() {
  const [active, setActive] = useState(0);
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [client] = useState(() => {
    const c = new PortClient();
    c.connect();
    return c;
  });

  async function handleCreate() {
    setError(null);
    if (pw.length < 8) {
      setError("Password must be at least 8 characters");
      return;
    }
    if (pw !== confirm) {
      setError("Passwords don't match");
      return;
    }
    setSubmitting(true);
    try {
      await client.call("vault.initialize", [pw]);
      setActive(2);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Box sx={{ p: 4, maxWidth: 480, mx: "auto" }}>
      <Stepper activeStep={active} sx={{ mb: 4 }}>
        {steps.map((s) => (
          <Step key={s}>
            <StepLabel>{s}</StepLabel>
          </Step>
        ))}
      </Stepper>

      {active === 0 && (
        <Box>
          <Typography variant="h5" gutterBottom>
            Welcome to Aztec Wallet
          </Typography>
          <Typography variant="body2" color="text.secondary" paragraph>
            This extension stores Aztec accounts and signs transactions for dApps.
            You'll set a password next — it locks the wallet UI on idle.
          </Typography>
          <Button variant="contained" onClick={() => setActive(1)}>
            Continue
          </Button>
        </Box>
      )}

      {active === 1 && (
        <Box>
          <Typography variant="h6" gutterBottom>
            Set a password
          </Typography>
          <TextField
            type="password"
            label="Password"
            fullWidth
            margin="normal"
            value={pw}
            onChange={(e) => setPw(e.target.value)}
          />
          <TextField
            type="password"
            label="Confirm password"
            fullWidth
            margin="normal"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
          {error && (
            <Typography color="error" variant="body2">
              {error}
            </Typography>
          )}
          <Button
            variant="contained"
            onClick={handleCreate}
            disabled={submitting}
            sx={{ mt: 2 }}
          >
            {submitting ? "Creating…" : "Create wallet"}
          </Button>
        </Box>
      )}

      {active === 2 && (
        <Box>
          <Typography variant="h5" gutterBottom>
            You're all set
          </Typography>
          <Typography variant="body2" color="text.secondary" paragraph>
            Click the toolbar icon to open the wallet, or visit a dApp to begin.
          </Typography>
          <Button variant="outlined" onClick={() => window.close()}>
            Close
          </Button>
        </Box>
      )}
    </Box>
  );
}
