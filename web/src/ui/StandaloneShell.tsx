/**
 * StandaloneShell — full wallet UI when the web wallet is accessed directly
 * (not embedded as an iframe). Identical in look/feel to the Electron app.
 *
 * Gating flow:
 *   1. PIN check — first load: set a new PIN; subsequent loads: enter existing PIN
 *   2. Once PIN is verified → mount Root (PXE + wallet UI)
 */

import { useState, useCallback, useEffect } from "react";
import { Root } from "@demo-wallet/shared/ui";
import { WalletApi } from "./utils/wallet-api.ts";
import { PinDialog } from "./components/PinDialog.tsx";
import { hasAccountsCookie, readAccountsCookie } from "../wallet/sync-cookies.ts";
import { setCookiePassphrase } from "../wallet/wallet-service.ts";

export function StandaloneShell() {
  const [pinReady, setPinReady] = useState(false);
  const [pinMode, setPinMode] = useState<"set" | "enter">("set");
  const [pinError, setPinError] = useState<string | null>(null);

  useEffect(() => {
    setPinMode(hasAccountsCookie() ? "enter" : "set");
  }, []);

  const handlePinSubmit = useCallback(
    async (pin: string) => {
      setPinError(null);

      if (pinMode === "enter") {
        try {
          await readAccountsCookie(pin);
        } catch {
          setPinError("Wrong PIN. Please try again.");
          return;
        }
      }

      setCookiePassphrase(pin);
      setPinReady(true);
    },
    [pinMode],
  );

  if (!pinReady) {
    return <PinDialog mode={pinMode} error={pinError} onSubmit={handlePinSubmit} />;
  }

  return <Root walletApiFactory={WalletApi.create} />;
}
