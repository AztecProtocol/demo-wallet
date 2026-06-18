import { Fr } from "@aztec/aztec.js/fields";
import type { AztecAddress } from "@aztec/aztec.js/addresses";
import { useContext, useEffect, useState } from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Typography from "@mui/material/Typography";
import Snackbar from "@mui/material/Snackbar";
import Alert from "@mui/material/Alert";
import CircularProgress from "@mui/material/CircularProgress";
import Dialog from "@mui/material/Dialog";
import DialogTitle from "@mui/material/DialogTitle";
import List from "@mui/material/List";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemText from "@mui/material/ListItemText";
import { randomBytes } from "@aztec/foundation/crypto/random";
import Link from "@mui/material/Link";
import { AccountBox } from "./components/AccountBox.tsx";
import { DraggableFab } from "../../shared/DraggableFab.tsx";
import { WalletContext } from "../../../renderer";
import { useNetwork } from "../../../contexts/NetworkContext";
import type { InternalAccount } from "../../../../wallet/core/internal-wallet";
import type { AccountType } from "../../../../wallet/database/wallet-db";

/** Account types offered in the create-account dialog, with user-facing labels. */
const ACCOUNT_TYPE_OPTIONS: {
  type: AccountType;
  label: string;
  description: string;
}[] = [
  {
    type: "schnorr_initializerless",
    label: "Schnorr (initializerless)",
    description: "No deployment needed — usable immediately",
  },
  {
    type: "schnorr",
    label: "Schnorr",
    description: "Requires an on-chain deployment transaction",
  },
  {
    type: "ecdsasecp256r1",
    label: "ECDSA (secp256r1)",
    description: "Requires an on-chain deployment transaction",
  },
  {
    type: "ecdsasecp256k1",
    label: "ECDSA (secp256k1)",
    description: "Requires an on-chain deployment transaction",
  },
];

export function AccountsManager() {
  const [accounts, setAccounts] = useState<InternalAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [creatingType, setCreatingType] = useState<AccountType | null>(null);

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

  const handleCreateAccount = async (type: AccountType) => {
    const option = ACCOUNT_TYPE_OPTIONS.find((o) => o.type === type);
    setCreatingType(type);
    try {
      await walletAPI.createAccount(
        `${option?.label ?? type} ${accounts.length}`,
        type,
        Fr.random(),
        Fr.random(),
        randomBytes(32),
      );
      setCreateDialogOpen(false);
      await loadAccounts();
    } catch (err: any) {
      setError(err.message || "Failed to create account");
    } finally {
      setCreatingType(null);
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
      {!embeddedMode && <DraggableFab onClick={() => setCreateDialogOpen(true)} />}

      {/* Account-type chooser */}
      <Dialog
        open={createDialogOpen}
        onClose={() => creatingType === null && setCreateDialogOpen(false)}
        fullWidth
        maxWidth="xs"
      >
        <DialogTitle>Create account</DialogTitle>
        <List sx={{ pt: 0 }}>
          {ACCOUNT_TYPE_OPTIONS.map((option) => (
            <ListItemButton
              key={option.type}
              disabled={creatingType !== null}
              onClick={() => handleCreateAccount(option.type)}
            >
              <ListItemText primary={option.label} secondary={option.description} />
              {creatingType === option.type && <CircularProgress size={20} />}
            </ListItemButton>
          ))}
        </List>
      </Dialog>
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
