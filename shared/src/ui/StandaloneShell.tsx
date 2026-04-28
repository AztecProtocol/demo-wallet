/**
 * StandaloneShell — full wallet UI shell used when the wallet is rendered
 * directly (not embedded as an iframe).
 *
 * Gating flow:
 *   1. PIN check — first load: set a new PIN; subsequent loads: enter existing PIN
 *   2. Once PIN is verified → mount Root (PXE + wallet UI)
 *
 * Host-specific bits (vault existence check, PIN verification, PIN persistence,
 * wallet API factory) are injected via props so that web, extension, and other
 * flavors can share the same shell.
 */

import { useState, useCallback, useEffect } from "react";
import { Root, type RootProps } from "./renderer.tsx";
import { PinDialog } from "./components/PinDialog.tsx";

export interface StandaloneShellProps {
  /** Whether persisted vault/cookie data exists. Used to choose set-PIN vs enter-PIN. */
  hasExistingVault: () => boolean | Promise<boolean>;
  /** Verify the entered PIN/password. Throws on wrong password. */
  verifyPin: (pin: string) => Promise<void>;
  /**
   * Persist the PIN/password for this session. May be sync (web cookie) or
   * async (extension storage); the shell awaits it before mounting Root, so
   * downstream code can rely on persistence completing first.
   */
  setPin: (pin: string) => void | Promise<void>;
  /** Wallet API factory passed to <Root />. */
  walletApiFactory: RootProps["walletApiFactory"];
}

export function StandaloneShell({
  hasExistingVault,
  verifyPin,
  setPin,
  walletApiFactory,
}: StandaloneShellProps) {
  const [pinReady, setPinReady] = useState(false);
  const [pinMode, setPinMode] = useState<"set" | "enter">("set");
  const [pinError, setPinError] = useState<string | null>(null);

  useEffect(() => {
    Promise.resolve(hasExistingVault()).then((existing) => {
      setPinMode(existing ? "enter" : "set");
    });
  }, [hasExistingVault]);

  const handlePinSubmit = useCallback(
    async (pin: string) => {
      setPinError(null);

      if (pinMode === "enter") {
        try {
          await verifyPin(pin);
        } catch {
          setPinError("Wrong PIN. Please try again.");
          return;
        }
      }

      await setPin(pin);
      setPinReady(true);
    },
    [pinMode, verifyPin, setPin],
  );

  if (!pinReady) {
    return <PinDialog mode={pinMode} error={pinError} onSubmit={handlePinSubmit} />;
  }

  return <Root walletApiFactory={walletApiFactory} />;
}
