import { createRoot } from "react-dom/client";
import { ThemeProvider, createTheme, CssBaseline } from "@mui/material";
import { StandaloneShell } from "@demo-wallet/shared/ui";
import { PortClient } from "../../src/ipc/port-client";
import { hasVaultMeta } from "../../src/vault/vault-meta";
import { makePortWalletApi } from "../../src/ui/port-wallet-api";

const client = new PortClient();
client.connect();

const theme = createTheme({ palette: { mode: "dark" } });

createRoot(document.getElementById("root")!).render(
  <ThemeProvider theme={theme}>
    <CssBaseline />
    <StandaloneShell
      hasExistingVault={hasVaultMeta}
      verifyPin={async (pin) => {
        const ok = await client.call<boolean>("vault.unlock", [pin]);
        if (!ok) throw new Error("wrong password");
      }}
      setPin={async (pin) => {
        // First-install path: if no vault yet, treat the entered PIN as the
        // initial password. Otherwise verifyPin (above) has already unlocked
        // the vault on the offscreen side, so this is a no-op.
        const initialized = await client.call<boolean>("vault.isInitialized", []);
        if (!initialized) {
          await client.call("vault.initialize", [pin]);
        }
      }}
      walletApiFactory={(chainId, version) => makePortWalletApi(client, chainId, version)}
    />
  </ThemeProvider>,
);
