import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider, createTheme, CssBaseline } from "@mui/material";
import { StandaloneShell } from "@demo-wallet/shared/ui";
import { PortClient } from "../../src/ipc/port-client";
import { hasVaultMeta } from "../../src/vault/vault-meta";
import { makePortWalletApi } from "../../src/ui/port-wallet-api";

const client = new PortClient();
client.connect();

// Dev-only helper for testing reactive vault state across surfaces. Run e.g.
// `extensionWallet.lock()` in the expanded view's console with the popup
// detached (right-click popup → Inspect) and watch the popup snap to lock.
(globalThis as { extensionWallet?: unknown }).extensionWallet = {
  lock: () => client.call("vault.lock", []),
  unlock: (password: string) => client.call<boolean>("vault.unlock", [password]),
  isUnlocked: () => client.call<boolean>("vault.isUnlocked", []),
  client,
};

const theme = createTheme({ palette: { mode: "dark" } });

/**
 * Wraps StandaloneShell so it remounts on every vault-locked broadcast. The
 * shell's `isAlreadyUnlocked` check only runs at mount; without remounting,
 * locking the vault from another surface (popup, devtools) leaves the expanded
 * view stuck on the unlocked Root view. Bumping a `key` is the cheapest way to
 * force remount without touching the shared shell.
 */
function ExpandedApp() {
  const [epoch, setEpoch] = useState(0);
  useEffect(() => client.onBroadcast("vault-locked", () => setEpoch((e) => e + 1)), []);

  return (
    <StandaloneShell
      key={epoch}
      hasExistingVault={hasVaultMeta}
      isAlreadyUnlocked={() => client.call<boolean>("vault.isUnlocked", [])}
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
  );
}

createRoot(document.getElementById("root")!).render(
  <ThemeProvider theme={theme}>
    <CssBaseline />
    <ExpandedApp />
  </ThemeProvider>,
);
