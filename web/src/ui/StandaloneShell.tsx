/**
 * Web flavor's StandaloneShell — thin wrapper that wires the shared
 * StandaloneShell to the web's cookie-passphrase auth and WalletApi transport.
 */

import { StandaloneShell as Shell } from "@demo-wallet/shared/ui";
import { WalletApi } from "./utils/wallet-api.ts";
import { hasAccountsCookie, readAccountsCookie } from "../wallet/sync-cookies.ts";
import { setCookiePassphrase } from "../wallet/wallet-service.ts";

export function StandaloneShell() {
  return (
    <Shell
      hasExistingVault={hasAccountsCookie}
      verifyPin={(pin) => readAccountsCookie(pin).then(() => undefined)}
      setPin={setCookiePassphrase}
      walletApiFactory={WalletApi.create}
    />
  );
}
