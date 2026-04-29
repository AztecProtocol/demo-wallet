import { useEffect, useState } from "react";
import { Box, Button, TextField, Typography, Stack } from "@mui/material";
import { PortClient } from "../../src/ipc/port-client";

export function Popup() {
  const [client] = useState(() => {
    const c = new PortClient();
    c.connect();
    return c;
  });
  const [unlocked, setUnlocked] = useState<boolean | null>(null);
  const [pw, setPw] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void client.call<boolean>("vault.isUnlocked", []).then(setUnlocked);
    const off1 = client.onBroadcast("vault-locked", () => setUnlocked(false));
    const off2 = client.onBroadcast("vault-unlocked", () => setUnlocked(true));
    return () => {
      off1();
      off2();
    };
  }, [client]);

  async function handleUnlock() {
    setError(null);
    const ok = await client.call<boolean>("vault.unlock", [pw]);
    if (!ok) setError("Incorrect password");
    setPw("");
  }

  if (unlocked === null) return null;

  if (!unlocked) {
    return (
      <Box sx={{ p: 3 }}>
        <Typography variant="h6" gutterBottom>
          Wallet locked
        </Typography>
        <TextField
          type="password"
          label="Password"
          fullWidth
          margin="normal"
          value={pw}
          onChange={(e) => setPw(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleUnlock();
          }}
        />
        {error && (
          <Typography color="error" variant="body2">
            {error}
          </Typography>
        )}
        <Button
          variant="contained"
          onClick={handleUnlock}
          fullWidth
          sx={{ mt: 2 }}
        >
          Unlock
        </Button>
      </Box>
    );
  }

  return (
    <Box sx={{ p: 3 }}>
      <Stack spacing={2}>
        <Typography variant="h6">Aztec Wallet</Typography>
        <Typography variant="body2" color="text.secondary">
          Wallet unlocked. Use the expanded view for full features.
        </Typography>
        <Button
          variant="outlined"
          onClick={() => {
            chrome.tabs.create({
              url: chrome.runtime.getURL("expanded/index.html"),
            });
          }}
        >
          Open expanded view
        </Button>
        <Button variant="text" onClick={() => client.call("vault.lock", [])}>
          Lock
        </Button>
      </Stack>
    </Box>
  );
}
