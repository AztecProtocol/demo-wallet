import { StrictMode, createContext, useMemo } from "react";
import "./index.css";
import { createTheme, CssBaseline, type ThemeOptions, ThemeProvider } from "@mui/material";
import { colors } from "./styles.ts";
import { App } from "./App.tsx";
import type { InternalWalletInterface } from "../ipc/wallet-internal-interface.ts";
import { NetworkProvider, useNetwork } from "./contexts/NetworkContext.tsx";
import { networkToChainInfo } from "../config/networks.ts";
import type { Fr } from "@aztec/foundation/schemas";

const themeOptions: ThemeOptions = {
  breakpoints: {
    values: {
      xs: 0,
      sm: 360,
      md: 700,
      lg: 1200,
      xl: 1536,
    },
  },
  palette: {
    mode: "dark",
    primary: {
      main: colors.primary,
    },
    secondary: {
      main: colors.secondary,
    },
  },
  typography: {
    fontFamily: "monospace",
    subtitle2: {
      color: "darkgrey",
    },
  },
};

const theme = createTheme(themeOptions);

export const WalletContext = createContext<{
  walletAPI: InternalWalletInterface;
  embeddedMode?: boolean;
  /** Iframe-only: re-read account cookie and import new accounts into WalletDB */
  onRefreshAccounts?: () => Promise<void>;
}>({ walletAPI: null! });

interface WalletProviderWrapperProps {
  walletApiFactory: (chainId: Fr, version: Fr) => InternalWalletInterface;
}

function WalletProviderWrapper({ walletApiFactory }: WalletProviderWrapperProps) {
  const { currentNetwork } = useNetwork();
  const chainInfo = networkToChainInfo(currentNetwork);

  // Create wallet API with current network's chain info
  const walletAPI = useMemo(
    () => walletApiFactory(chainInfo.chainId, chainInfo.version),
    [currentNetwork.id], // Recreate when network changes
  );

  const walletContext = useMemo(() => ({ walletAPI }), [walletAPI]);

  return (
    <WalletContext.Provider value={walletContext}>
      <CssBaseline />
      <App />
    </WalletContext.Provider>
  );
}

export interface RootProps {
  walletApiFactory: (chainId: Fr, version: Fr) => InternalWalletInterface;
}

export function Root({ walletApiFactory }: RootProps) {
  return (
    <StrictMode>
      <ThemeProvider theme={theme}>
        <NetworkProvider>
          <WalletProviderWrapper walletApiFactory={walletApiFactory} />
        </NetworkProvider>
      </ThemeProvider>
    </StrictMode>
  );
}
