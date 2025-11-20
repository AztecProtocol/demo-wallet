import { useContext, useEffect, useState } from "react";
import {
  Card,
  CardContent,
  Typography,
  Box,
  Chip,
  Button,
  IconButton,
  Tooltip,
  Alert,
  Accordion,
  AccordionSummary,
  AccordionDetails,
  List,
  ListItem,
  ListItemText,
  ListItemSecondaryAction,
} from "@mui/material";
import {
  Apps as AppsIcon,
  Edit as EditIcon,
  Block as RevokeIcon,
  AccountCircle,
  ExpandMore as ExpandMoreIcon,
  Science as SimulationIcon,
  Delete as DeleteIcon,
} from "@mui/icons-material";
import { WalletContext } from "../../../../renderer";
import { EditAccountAuthorizationDialog } from "../../../dialogs/EditAccountAuthorizationDialog";
import { EditAddressBookAuthorizationDialog } from "../../../dialogs/EditAddressBookAuthorizationDialog";
import { ExecutionTraceDialog } from "../../../dialogs/ExecutionTraceDialog";
import { AztecAddress } from "@aztec/aztec.js/addresses";

interface AppAuthorizationCardProps {
  appId: string;
  onRevoke: (appId: string) => Promise<void>;
  onUpdate: () => Promise<void>;
}

interface Authorizations {
  accounts: { alias: string; item: string }[];
  contacts: { alias: string; item: string }[];
  simulations: Array<{
    type: "simulateTx" | "simulateUtility";
    payloadHash: string;
    title?: string;
    key: string;
  }>;
  otherMethods: string[];
}

export function AppAuthorizationCard({
  appId,
  onRevoke,
  onUpdate,
}: AppAuthorizationCardProps) {
  const { walletAPI } = useContext(WalletContext);
  const [authorizations, setAuthorizations] = useState<Authorizations>({
    accounts: [],
    contacts: [],
    simulations: [],
    otherMethods: [],
  });
  const [loading, setLoading] = useState(true);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [editContactsDialogOpen, setEditContactsDialogOpen] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [accountList, setAccountList] = useState<
    Array<{ alias: string; item: string }>
  >([]);
  const [contactList, setContactList] = useState<
    Array<{ alias: string; item: string }>
  >([]);

  useEffect(() => {
    loadAuthorizations();
  }, [appId]);

  const loadAuthorizations = async () => {
    try {
      setLoading(true);
      // Load all in parallel and wait for all to complete
      const [auths, accounts, contacts] = await Promise.all([
        walletAPI.getAppAuthorizations(appId),
        walletAPI.getAccounts(),
        walletAPI.getAddressBook(),
      ]);
      setAuthorizations(auths);
      setAccountList(accounts);
      setContactList(contacts);
      console.log(
        "[AppAuthorizationCard] Loaded auths, accounts, and contacts:",
        {
          auths,
          accounts,
          contacts,
        }
      );
    } catch (err) {
      console.error("Failed to load app authorizations:", err);
    } finally {
      setLoading(false);
    }
  };

  const handleRevoke = async () => {
    if (
      !confirm(
        `Are you sure you want to revoke all authorizations for ${appId}? The app will need to request authorization again.`
      )
    ) {
      return;
    }

    try {
      setRevoking(true);
      await onRevoke(appId);
    } catch (err) {
      console.error("Failed to revoke:", err);
    } finally {
      setRevoking(false);
    }
  };

  const handleRevokeSimulation = async (key: string) => {
    if (
      !confirm(
        `Are you sure you want to revoke this specific simulation authorization?`
      )
    ) {
      return;
    }

    try {
      console.log("Revoking authorization with key:", key);
      await walletAPI.revokeAuthorization(key);
      console.log("Authorization revoked successfully");
      await loadAuthorizations();
      await onUpdate();
    } catch (err) {
      console.error("Failed to revoke simulation:", err);
      alert(`Failed to revoke authorization: ${err}`);
    }
  };

  const handleEditSave = async () => {
    setEditDialogOpen(false);
    await loadAuthorizations();
    await onUpdate();
  };

  const handleEditContactsSave = async () => {
    setEditContactsDialogOpen(false);
    await loadAuthorizations();
    await onUpdate();
  };

  const accounts = authorizations.accounts || [];
  const contacts = authorizations.contacts || [];
  const simulations = authorizations.simulations || [];
  const otherMethods = authorizations.otherMethods || [];

  const [selectedSimulationHash, setSelectedSimulationHash] = useState<
    string | null
  >(null);
  const [executionTrace, setExecutionTrace] = useState<any>(null);
  const [traceDialogOpen, setTraceDialogOpen] = useState(false);
  const [loadingTrace, setLoadingTrace] = useState(false);

  const handleViewSimulation = async (payloadHash: string) => {
    try {
      setLoadingTrace(true);
      setSelectedSimulationHash(payloadHash);

      // Payload hash IS the interaction ID for simulations
      const result = await walletAPI.getExecutionTrace(payloadHash);
      if (result) {
        setExecutionTrace(result);
        setTraceDialogOpen(true);
      } else {
        alert("Execution trace not found for this simulation");
      }
    } catch (err) {
      console.error("Failed to load execution trace:", err);
      alert("Failed to load execution trace");
    } finally {
      setLoadingTrace(false);
    }
  };

  return (
    <>
      <Card sx={{ width: "100%", position: "relative" }}>
        <CardContent>
          <Box
            sx={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "flex-start",
              mb: 2,
            }}
          >
            <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
              <AppsIcon color="primary" />
              <Typography variant="h6">{appId}</Typography>
            </Box>
            <Box sx={{ display: "flex", gap: 1 }}>
              <Tooltip title="Revoke All Authorizations">
                <IconButton
                  size="small"
                  color="error"
                  onClick={handleRevoke}
                  disabled={loading || revoking}
                >
                  <RevokeIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            </Box>
          </Box>

          {loading ? (
            <Typography variant="body2" color="text.secondary">
              Loading...
            </Typography>
          ) : (
            <>
              {accounts.length > 0 && (
                <Box sx={{ mb: 2 }}>
                  <Accordion
                    sx={{
                      bgcolor: "rgba(0, 0, 0, 0.01)",
                      boxShadow: 1,
                      border: "1px solid",
                      borderColor: "divider",
                    }}
                  >
                    <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                      <Box
                        sx={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          width: "100%",
                        }}
                      >
                        <Box
                          sx={{ display: "flex", alignItems: "center", gap: 1 }}
                        >
                          <AccountCircle fontSize="small" />
                          <Typography variant="subtitle2">
                            Authorized Accounts ({accounts.length})
                          </Typography>
                        </Box>
                        <IconButton
                          size="small"
                          onClick={(e) => {
                            e.stopPropagation();
                            setEditDialogOpen(true);
                          }}
                          sx={{ mr: 1 }}
                        >
                          <EditIcon fontSize="small" />
                        </IconButton>
                      </Box>
                    </AccordionSummary>
                    <AccordionDetails>
                      <Box
                        sx={{
                          display: "flex",
                          flexDirection: "column",
                          gap: 1.5,
                        }}
                      >
                        {accounts.map(
                          (acc: { alias: string; item: string }) => {
                            const internalAccount = accountList.find(
                              (a: { alias: string; item: AztecAddress }) =>
                                a.item.equals(AztecAddress.fromString(acc.item))
                            );

                            return (
                              <Box
                                key={acc.item}
                                sx={{
                                  display: "flex",
                                  flexDirection: "column",
                                  gap: 0.5,
                                  p: 1.5,
                                  bgcolor: "rgba(0, 0, 0, 0.01)",
                                  borderRadius: 1,
                                  border: "1px solid",
                                  borderColor: "divider",
                                }}
                              >
                                <Box
                                  sx={{
                                    display: "flex",
                                    alignItems: "center",
                                    gap: 1,
                                  }}
                                >
                                  <AccountCircle
                                    fontSize="small"
                                    color="primary"
                                  />
                                  <Typography
                                    variant="body2"
                                    sx={{
                                      fontWeight: "medium",
                                      fontFamily: "monospace",
                                    }}
                                  >
                                    {internalAccount?.alias ||
                                      "Unknown Account"}
                                  </Typography>
                                  <Chip
                                    label={`→ ${acc.alias}`}
                                    size="small"
                                    sx={{
                                      bgcolor: "rgba(25, 118, 210, 0.08)",
                                      color: "primary.main",
                                      fontFamily: "monospace",
                                      fontSize: "0.7rem",
                                      fontWeight: "medium",
                                      height: "20px",
                                      "& .MuiChip-label": {
                                        px: 1,
                                      },
                                    }}
                                  />
                                </Box>
                                <Typography
                                  variant="caption"
                                  color="text.secondary"
                                  sx={{
                                    fontFamily: "monospace",
                                    ml: 3.5,
                                  }}
                                >
                                  {acc.item.slice(0, 10)}...
                                  {acc.item.slice(-8)}
                                </Typography>
                              </Box>
                            );
                          }
                        )}
                      </Box>
                    </AccordionDetails>
                  </Accordion>
                </Box>
              )}

              <Box sx={{ mb: 2 }}>
                <Accordion
                  sx={{
                    bgcolor: "rgba(0, 0, 0, 0.01)",
                    boxShadow: 1,
                    border: "1px solid",
                    borderColor: "divider",
                  }}
                >
                  <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                    <Box
                      sx={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        width: "100%",
                      }}
                    >
                      <Box
                        sx={{ display: "flex", alignItems: "center", gap: 1 }}
                      >
                        <AccountCircle fontSize="small" />
                        <Typography variant="subtitle2">
                          Authorized Contacts ({contacts.length})
                        </Typography>
                      </Box>
                      <IconButton
                        size="small"
                        onClick={(e) => {
                          e.stopPropagation();
                          setEditContactsDialogOpen(true);
                        }}
                        sx={{ mr: 1 }}
                      >
                        <EditIcon fontSize="small" />
                      </IconButton>
                    </Box>
                  </AccordionSummary>
                  <AccordionDetails>
                    {contacts.length === 0 ? (
                      <Typography variant="body2" color="text.secondary">
                        No contacts shared with this app. Click the edit button to grant access.
                      </Typography>
                    ) : (
                      <Box
                        sx={{
                          display: "flex",
                          flexDirection: "column",
                          gap: 1.5,
                        }}
                      >
                        {contacts.map(
                          (contact: { alias: string; item: string }) => {
                            const internalContact = contactList.find(
                              (c: { alias: string; item: AztecAddress }) =>
                                c.item.equals(
                                  AztecAddress.fromString(contact.item)
                                )
                            );

                            return (
                              <Box
                                key={contact.item}
                                sx={{
                                  display: "flex",
                                  flexDirection: "column",
                                  gap: 0.5,
                                  p: 1.5,
                                  bgcolor: "rgba(0, 0, 0, 0.01)",
                                  borderRadius: 1,
                                  border: "1px solid",
                                  borderColor: "divider",
                                }}
                              >
                                <Box
                                  sx={{
                                    display: "flex",
                                    alignItems: "center",
                                    gap: 1,
                                  }}
                                >
                                  <AccountCircle
                                    fontSize="small"
                                    color="primary"
                                  />
                                  <Typography
                                    variant="body2"
                                    sx={{
                                      fontWeight: "medium",
                                      fontFamily: "monospace",
                                    }}
                                  >
                                    {internalContact?.alias ||
                                      "Unknown Contact"}
                                  </Typography>
                                  <Chip
                                    label={`→ ${contact.alias}`}
                                    size="small"
                                    sx={{
                                      bgcolor: "rgba(25, 118, 210, 0.08)",
                                      color: "primary.main",
                                      fontFamily: "monospace",
                                      fontSize: "0.7rem",
                                      fontWeight: "medium",
                                      height: "20px",
                                      "& .MuiChip-label": {
                                        px: 1,
                                      },
                                    }}
                                  />
                                </Box>
                                <Typography
                                  variant="caption"
                                  color="text.secondary"
                                  sx={{
                                    fontFamily: "monospace",
                                    ml: 3.5,
                                  }}
                                >
                                  {contact.item.slice(0, 10)}...
                                  {contact.item.slice(-8)}
                                </Typography>
                              </Box>
                            );
                          }
                        )}
                      </Box>
                    )}
                  </AccordionDetails>
                </Accordion>
              </Box>

              {simulations.length > 0 && (
                <Box sx={{ mb: 2 }}>
                  <Accordion
                    sx={{
                      bgcolor: "rgba(0, 0, 0, 0.01)",
                      boxShadow: 1,
                      border: "1px solid",
                      borderColor: "divider",
                    }}
                  >
                    <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                      <Box
                        sx={{ display: "flex", alignItems: "center", gap: 1 }}
                      >
                        <SimulationIcon fontSize="small" />
                        <Typography variant="subtitle2">
                          Authorized Simulations ({simulations.length})
                        </Typography>
                      </Box>
                    </AccordionSummary>
                    <AccordionDetails>
                      <List dense>
                        {simulations.map((sim) => (
                          <ListItem
                            key={sim.key}
                            sx={{
                              border: 1,
                              borderColor: "divider",
                              borderRadius: 1,
                              mb: 1,
                              cursor: "pointer",
                              "&:hover": {
                                bgcolor: "action.hover",
                              },
                            }}
                            onClick={() =>
                              handleViewSimulation(sim.payloadHash)
                            }
                          >
                            <ListItemText
                              primary={
                                <Box
                                  sx={{
                                    display: "flex",
                                    alignItems: "center",
                                    gap: 1,
                                  }}
                                >
                                  <Chip
                                    label={
                                      sim.type === "simulateTx"
                                        ? "Tx"
                                        : "Utility"
                                    }
                                    size="small"
                                    color={
                                      sim.type === "simulateTx"
                                        ? "primary"
                                        : "secondary"
                                    }
                                    sx={{
                                      fontFamily: "monospace",
                                      fontSize: "0.65rem",
                                    }}
                                  />
                                  <Typography variant="body2">
                                    {sim.title || "Simulation"}
                                  </Typography>
                                </Box>
                              }
                              secondary={
                                <Typography
                                  variant="caption"
                                  color="text.secondary"
                                  sx={{ fontFamily: "monospace" }}
                                >
                                  Hash: {sim.payloadHash.slice(0, 10)}...
                                  {sim.payloadHash.slice(-8)}
                                </Typography>
                              }
                            />
                            <ListItemSecondaryAction>
                              <Tooltip title="Revoke this simulation">
                                <IconButton
                                  edge="end"
                                  size="small"
                                  color="error"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleRevokeSimulation(sim.key);
                                  }}
                                >
                                  <DeleteIcon fontSize="small" />
                                </IconButton>
                              </Tooltip>
                            </ListItemSecondaryAction>
                          </ListItem>
                        ))}
                      </List>
                    </AccordionDetails>
                  </Accordion>
                </Box>
              )}

              {accounts.length === 0 && simulations.length === 0 && (
                <Alert severity="warning">
                  No authorizations found for this app
                </Alert>
              )}

              {otherMethods.length > 0 && (
                <Box>
                  <Typography variant="caption" color="text.secondary">
                    Other Methods: {otherMethods.join(", ")}
                  </Typography>
                </Box>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <EditAccountAuthorizationDialog
        open={editDialogOpen}
        appId={appId}
        currentAccounts={accounts}
        onClose={() => setEditDialogOpen(false)}
        onSave={handleEditSave}
      />

      <EditAddressBookAuthorizationDialog
        open={editContactsDialogOpen}
        appId={appId}
        currentContacts={contacts}
        onClose={() => setEditContactsDialogOpen(false)}
        onSave={handleEditContactsSave}
      />

      {executionTrace && (
        <ExecutionTraceDialog
          open={traceDialogOpen}
          trace={executionTrace.trace}
          stats={executionTrace.stats}
          onClose={() => {
            setTraceDialogOpen(false);
            setExecutionTrace(null);
            setSelectedSimulationHash(null);
          }}
        />
      )}
    </>
  );
}
