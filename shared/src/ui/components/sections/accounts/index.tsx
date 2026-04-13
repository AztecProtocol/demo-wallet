import { Fr } from "@aztec/aztec.js/fields";
import type { AztecAddress } from "@aztec/aztec.js/addresses";
import { useContext, useEffect, useState } from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Typography from "@mui/material/Typography";
import Snackbar from "@mui/material/Snackbar";
import Alert from "@mui/material/Alert";
import CircularProgress from "@mui/material/CircularProgress";
import { randomBytes } from "@aztec/foundation/crypto/random";
import Link from "@mui/material/Link";
import { AccountBox } from "./components/AccountBox.tsx";
import { DraggableFab } from "../../shared/DraggableFab.tsx";
import { WalletContext } from "../../../renderer";
import { useNetwork } from "../../../contexts/NetworkContext";
import type { InternalAccount } from "../../../../wallet/core/internal-wallet";

export function AccountsManager() {
  const [accounts, setAccounts] = useState<InternalAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const { walletAPI, embeddedMode, onRefreshAccounts } = useContext(WalletContext);
  const { currentNetwork } = useNetwork();

  const loadAccounts = async () => {
    const accounts = await walletAPI.getAccounts();
    setAccounts(accounts);
  };

  useEffect(() => {
    setLoading(true);
    loadAccounts().finally(() => setLoading(false));
  }, [currentNetwork.id, walletAPI]); // Reload when network changes

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      if (onRefreshAccounts) await onRefreshAccounts();
      await loadAccounts();
    } catch (err: any) {
      setError(err.message || "Failed to refresh accounts");
    } finally {
      setRefreshing(false);
    }
  };

  const handleCreateAccount = async () => {
    try {
      await walletAPI.createAccount(
        `ECDSAR1 ${accounts.length}`,
        "ecdsasecp256r1",
        Fr.random(),
        Fr.random(),
        randomBytes(32),
      );
      await loadAccounts();
    } catch (err: any) {
      setError(err.message || "Failed to create account");
    }
  };

  const handleDeploy = async (address: AztecAddress) => {
    try {
      await walletAPI.deployAccount(address);
      await loadAccounts();
    } catch (err: any) {
      setError(err.message || "Failed to deploy account");
    }
  };

  if (loading) {
    return (
      <Box
        sx={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          width: "100%",
          height: "100%",
          gap: 2,
        }}
      >
        <CircularProgress size={32} />
        <Typography variant="body2" color="text.secondary">
          Loading accounts...
        </Typography>
      </Box>
    );
  }

  return (
    <>
      <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <Typography variant="h5" component="h2">
          Accounts
        </Typography>
        {embeddedMode && accounts.length === 0 ? (
          <Box sx={{ textAlign: "center", py: 4 }}>
            <Typography variant="body1" color="text.secondary" gutterBottom>
              No accounts found.
            </Typography>
            <Typography variant="body2" color="text.secondary" gutterBottom>
              Create an account in the standalone wallet first.
            </Typography>
            <Box sx={{ display: "flex", gap: 2, justifyContent: "center", mt: 1 }}>
              <Link href={window.location.origin} target="_blank" rel="noopener">
                Open wallet
              </Link>
              <Button variant="outlined" size="small" disabled={refreshing} onClick={handleRefresh}>
                {refreshing ? "Refreshing..." : "Refresh"}
              </Button>
            </Box>
          </Box>
        ) : (
          <Box
            sx={{
              display: "flex",
              width: "100%",
              flexDirection: "column",
              gap: 1,
            }}
          >
            {accounts.map((account, index) => (
              <AccountBox key={index} QRButton account={account} onDeploy={handleDeploy} />
            ))}
            {embeddedMode && (
              <Button
                variant="text"
                size="small"
                disabled={refreshing}
                onClick={handleRefresh}
                sx={{ alignSelf: "center", mt: 1 }}
              >
                {refreshing ? "Refreshing..." : "Refresh accounts"}
              </Button>
            )}
          </Box>
        )}
      </Box>

      {/* Draggable FAB for creating accounts — hidden in embedded mode */}
      {!embeddedMode && <DraggableFab onClick={handleCreateAccount} />}
      <Snackbar
        open={error !== null}
        autoHideDuration={6000}
        onClose={() => setError(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
      >
        <Alert onClose={() => setError(null)} severity="error" sx={{ width: "100%" }}>
          {error}
        </Alert>
      </Snackbar>
    </>
  );
}
