import { useContext, useEffect, useState, type MutableRefObject } from "react";
import {
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  Typography,
  List,
  ListItem,
  CircularProgress,
  keyframes,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  OutlinedInput,
  Checkbox,
  ListItemText,
  IconButton,
  Tooltip,
} from "@mui/material";
import {
  CheckCircle,
  Error as ErrorIcon,
  ContentCopy as CopyIcon,
  Close as CloseIcon,
} from "@mui/icons-material";
import type {
  WalletInteraction,
  WalletInteractionType,
} from "../../../../wallet/types/wallet-interaction";
import { ExecutionTraceDialog } from "../../dialogs/ExecutionTraceDialog";
import type { DecodedExecutionTrace } from "../../../../wallet/decoding/tx-callstack-decoder";
import type { ExecutionStats } from "../../shared/PhaseTimeline";
import { TxProgressTimeline } from "../../shared/TxProgressTimeline";
import { WalletContext } from "../../../renderer";

const TX_TYPES: WalletInteractionType[] = [
  "sendTx",
  "simulateTx",
  "simulateUtility",
  "createAccount",
  "deployAccount",
];

interface InteractionsListProps {
  interactions: WalletInteraction<WalletInteractionType>[];
  selectedTypes: WalletInteractionType[];
  onTypeFilterChange: (types: WalletInteractionType[]) => void;
  onDismiss: (id: string) => void;
  onClearCompleted: () => void;
  phaseStartsRef: MutableRefObject<Map<string, number>>;
}

const getStatusColor = (status: string, complete: boolean) => {
  if (status.includes("ERROR") || status.includes("FAIL")) return "error";
  if (complete) return "success";
  return "primary";
};

const pulse = keyframes`
  0%, 100% {
    opacity: 1;
  }
  50% {
    opacity: 0.5;
  }
`;

const shimmer = keyframes`
  0% {
    background-position: -1000px 0;
  }
  100% {
    background-position: 1000px 0;
  }
`;

const getStatusIcon = (status: string, complete: boolean) => {
  if (status.includes("ERROR") || status.includes("FAIL")) return <ErrorIcon fontSize="small" />;
  if (complete) return <CheckCircle fontSize="small" />;
  return <CircularProgress size={14} thickness={5} />;
};

// Check if a transaction has completed proving (status moved past PROVING)
const isProvenTx = (type: WalletInteractionType, status: string): boolean => {
  if (type !== "sendTx" && type !== "createAccount" && type !== "deployAccount") return false;
  const postProvingStatuses = ["SENDING", "SENT", "MINED", "DEPLOYED"];
  return postProvingStatuses.some((s) => status.includes(s));
};

const getInteractionTypeLabel = (type: WalletInteractionType) => {
  const labels: Record<WalletInteractionType, string> = {
    registerContract: "Register Contract",
    createAccount: "Create Account",
    deployAccount: "Deploy Account",
    simulateTx: "Simulate Transaction",
    simulateUtility: "Simulate Utility",
    sendTx: "Send Transaction",
    profileTx: "Profile Transaction",
    registerSender: "Register Sender",
    getAccounts: "Get Accounts",
    getAddressBook: "Get Address Book",
    createAuthWit: "Create Auth Witness",
    getPrivateEvents: "Get Private Events",
    getContractMetadata: "Get Contract Metadata",
    getContractClassMetadata: "Get Contract Class Metadata",
    requestCapabilities: "Request Capabilities",
  };
  return labels[type] || type;
};

const getInteractionTypeColor = (type: WalletInteractionType) => {
  const colors: Record<WalletInteractionType, string> = {
    registerContract: "#9c27b0", // purple
    createAccount: "#2196f3", // blue
    deployAccount: "#1565c0", // dark blue (deployment action)
    simulateTx: "#ff9800", // orange
    simulateUtility: "#ff9800", // orange (same as simulateTx)
    sendTx: "#7c4dff", // purple/violet (proving action)
    profileTx: "#00bcd4", // cyan
    registerSender: "#444444", // dark gray
    getAccounts: "#4caf50", // green (data access)
    getAddressBook: "#4caf50", // green (data access)
    createAuthWit: "#009688", // teal (signature action)
    getPrivateEvents: "#ff9800", // orange (privacy sensitive)
    getContractMetadata: "#03a9f4", // light blue (metadata query)
    getContractClassMetadata: "#03a9f4", // light blue (metadata query)
    requestCapabilities: "#2196f3", // blue (authorization/permissions)
  };
  return colors[type];
};

const allInteractionTypes: WalletInteractionType[] = [
  "registerContract",
  "createAccount",
  "deployAccount",
  "simulateTx",
  "simulateUtility",
  "sendTx",
  "profileTx",
  "registerSender",
  "getAccounts",
  "getAddressBook",
  "createAuthWit",
  "getPrivateEvents",
  "getContractMetadata",
  "getContractClassMetadata",
  "requestCapabilities",
];

/** Extract the TxHash from a sendTx interaction description (format: "TxHash: 0x...") */
function extractTxHash(description: string): string | null {
  const match = description.match(/TxHash:\s*(0x[a-fA-F0-9]+)/);
  return match ? match[1] : null;
}

export function InteractionsList({
  interactions,
  selectedTypes,
  onTypeFilterChange,
  onDismiss,
  onClearCompleted,
  phaseStartsRef,
}: InteractionsListProps) {
  const { walletAPI } = useContext(WalletContext);
  const [selectedTrace, setSelectedTrace] = useState<DecodedExecutionTrace | null>(null);
  const [selectedStats, setSelectedStats] = useState<ExecutionStats | undefined>(undefined);
  const [selectedFrom, setSelectedFrom] = useState<string | null>(null);
  const [selectedFeePayer, setSelectedFeePayer] = useState<string | null>(null);
  const [traceDialogOpen, setTraceDialogOpen] = useState(false);

  // Lazy-loaded stats for completed tx interactions (for the inline timeline)
  const [completedTimings, setCompletedTimings] = useState<Map<string, { stats?: ExecutionStats }>>(
    new Map(),
  );

  // Evict completed timings for interactions that are running again (same id, re-run).
  useEffect(() => {
    const rerunIds = interactions
      .filter((i) => !i.complete && TX_TYPES.includes(i.type) && completedTimings.has(i.id))
      .map((i) => i.id);
    if (rerunIds.length === 0) return;
    setCompletedTimings((prev) => {
      const next = new Map(prev);
      for (const id of rerunIds) next.delete(id);
      return next;
    });
  }, [interactions]);

  // Load phase timings for completed tx interactions.
  // Guard: don't fire while any TX interaction is still active — concurrent PXE DB
  // reads (via decodeTransaction → decodingCache) can corrupt in-flight IDB transactions.
  useEffect(() => {
    const hasActiveTx = interactions.some((i) => !i.complete && TX_TYPES.includes(i.type));
    if (hasActiveTx) return;

    const completedTxInteractions = interactions.filter(
      (i) => i.complete && TX_TYPES.includes(i.type) && !completedTimings.has(i.id),
    );
    if (completedTxInteractions.length === 0) return;

    for (const interaction of completedTxInteractions) {
      walletAPI
        .getExecutionTrace(interaction.id)
        .then((result) => {
          setCompletedTimings((prev) => {
            const next = new Map(prev);
            next.set(interaction.id, { stats: result?.stats as ExecutionStats | undefined });
            return next;
          });
        })
        .catch(() => {
          // Mark as attempted so we don't retry
          setCompletedTimings((prev) => {
            const next = new Map(prev);
            next.set(interaction.id, {});
            return next;
          });
        });
    }
  }, [interactions]);

  const handleInteractionClick = async (interaction: WalletInteraction<WalletInteractionType>) => {
    // Only show trace for simulateTx, simulateUtility, and sendTx interactions
    if (
      interaction.type === "simulateTx" ||
      interaction.type === "sendTx" ||
      interaction.type === "simulateUtility"
    ) {
      try {
        const result = await walletAPI.getExecutionTrace(interaction.id);
        if (result?.trace) {
          setSelectedTrace(result.trace);
          setSelectedStats(result.stats as ExecutionStats);
          setSelectedFrom(result.from || null);
          setSelectedFeePayer(result.embeddedPaymentMethodFeePayer || null);
          setTraceDialogOpen(true);
        }
      } catch (error) {
        console.error("Failed to load execution trace:", error);
      }
    }
  };

  const handleTypeFilterChange = (event: any) => {
    const value = event.target.value as WalletInteractionType[];
    onTypeFilterChange(value);
  };

  // Filter interactions based on selected types
  const filteredInteractions =
    selectedTypes.length === 0 || selectedTypes.length === allInteractionTypes.length
      ? interactions
      : interactions.filter((interaction) => selectedTypes.includes(interaction.type));

  return (
    <Box sx={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* Interactions List */}
      <Box sx={{ flexGrow: 1, overflowY: "auto" }}>
        {filteredInteractions.length === 0 ? (
          <Box sx={{ p: 2, textAlign: "center", color: "text.secondary" }}>
            <Typography variant="body2">
              {interactions.length === 0
                ? "No interactions yet"
                : "No interactions match the selected filters"}
            </Typography>
          </Box>
        ) : (
          <List sx={{ width: "100%", p: 0 }}>
            {filteredInteractions.map((interaction) => (
              <ListItem key={interaction.id} sx={{ px: 0, py: 0.5 }}>
                <Card
                  sx={{
                    width: "100%",
                    bgcolor: "background.paper",
                    transition: "all 0.2s",
                    overflow: "hidden",
                    cursor:
                      interaction.type === "simulateTx" ||
                      interaction.type === "simulateUtility" ||
                      interaction.type === "sendTx"
                        ? "pointer"
                        : "default",
                    borderLeft: "4px solid",
                    borderColor: getInteractionTypeColor(interaction.type),
                    "&:hover": {
                      boxShadow: 3,
                      transform: "translateY(-2px)",
                    },
                    // Add shimmer effect for in-progress interactions
                    ...(!interaction.complete && {
                      position: "relative",
                      "&::before": {
                        content: '""',
                        position: "absolute",
                        top: 0,
                        left: 0,
                        right: 0,
                        bottom: 0,
                        background: `linear-gradient(
                        90deg,
                        transparent 0%,
                        rgba(33, 150, 243, 0.1) 50%,
                        transparent 100%
                      )`,
                        backgroundSize: "1000px 100%",
                        animation: `${shimmer} 2s infinite linear`,
                        pointerEvents: "none",
                      },
                      animation: `${pulse} 2s ease-in-out infinite`,
                    }),
                  }}
                  onClick={() => handleInteractionClick(interaction)}
                >
                  <CardContent sx={{ py: 1.5, px: 2, "&:last-child": { pb: 1.5 } }}>
                    <Box
                      sx={{
                        display: "flex",
                        alignItems: "center",
                        gap: 1,
                        mb: 0.5,
                      }}
                    >
                      <Chip
                        label={getInteractionTypeLabel(interaction.type)}
                        size="small"
                        sx={{
                          fontSize: "0.7rem",
                          height: 20,
                          bgcolor: getInteractionTypeColor(interaction.type),
                          color: "white",
                          fontWeight: 600,
                          "& .MuiChip-label": {
                            px: 1,
                          },
                        }}
                      />
                      <Chip
                        icon={getStatusIcon(interaction.status, interaction.complete)}
                        label={interaction.status}
                        size="small"
                        color={getStatusColor(interaction.status, interaction.complete)}
                        sx={{ fontSize: "0.7rem", height: 20 }}
                      />
                      {isProvenTx(interaction.type, interaction.status) && (
                        <Chip
                          icon={<CheckCircle fontSize="small" />}
                          label="Proven"
                          size="small"
                          color="success"
                          variant="outlined"
                          sx={{ fontSize: "0.7rem", height: 20 }}
                        />
                      )}
                      <Tooltip title="Dismiss">
                        <IconButton
                          size="small"
                          sx={{ ml: "auto", p: 0.25, opacity: 0.5, "&:hover": { opacity: 1 } }}
                          onClick={(e) => {
                            e.stopPropagation();
                            onDismiss(interaction.id);
                          }}
                        >
                          <CloseIcon sx={{ fontSize: "0.9rem" }} />
                        </IconButton>
                      </Tooltip>
                    </Box>
                    <Typography
                      variant="body2"
                      fontWeight={500}
                      sx={{
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {interaction.title}
                    </Typography>
                    {interaction.type === "sendTx" && extractTxHash(interaction.description) ? (
                      <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
                        <Typography
                          variant="caption"
                          color="text.secondary"
                          sx={{
                            fontFamily: "monospace",
                            fontSize: "0.7rem",
                          }}
                        >
                          TxHash: {extractTxHash(interaction.description)!.slice(0, 18)}...
                        </Typography>
                        <Tooltip title="Copy TxHash">
                          <IconButton
                            size="small"
                            sx={{ p: 0.25 }}
                            onClick={(e) => {
                              e.stopPropagation();
                              navigator.clipboard.writeText(
                                extractTxHash(interaction.description)!,
                              );
                            }}
                          >
                            <CopyIcon sx={{ fontSize: "0.8rem" }} />
                          </IconButton>
                        </Tooltip>
                      </Box>
                    ) : interaction.description ? (
                      <Typography
                        variant="caption"
                        color="text.secondary"
                        sx={{
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {interaction.description}
                      </Typography>
                    ) : null}
                    <Typography
                      variant="caption"
                      color="text.secondary"
                      sx={{
                        display: "block",
                        mt: 0.5,
                        fontFamily: "monospace",
                        fontSize: "0.65rem",
                        opacity: 0.7,
                      }}
                    >
                      ID: {interaction.id.slice(0, 16)}...
                    </Typography>
                    {TX_TYPES.includes(interaction.type) && (
                      <TxProgressTimeline
                        interaction={interaction}
                        phaseStartsRef={phaseStartsRef}
                        timingsLoaded={completedTimings.has(interaction.id)}
                        stats={completedTimings.get(interaction.id)?.stats}
                      />
                    )}
                  </CardContent>
                </Card>
              </ListItem>
            ))}
          </List>
        )}
      </Box>

      {/* Filter Controls at Bottom */}
      <Box sx={{ p: 2, borderTop: 1, borderColor: "divider", display: "flex", gap: 1 }}>
        <FormControl size="small" sx={{ flex: 1 }}>
          <InputLabel id="interaction-type-filter-label">Filter by Type</InputLabel>
          <Select
            labelId="interaction-type-filter-label"
            id="interaction-type-filter"
            multiple
            value={selectedTypes}
            onChange={handleTypeFilterChange}
            input={<OutlinedInput label="Filter by Type" />}
            renderValue={(selected) =>
              selected.length === 0 || selected.length === allInteractionTypes.length
                ? "All Types"
                : `${selected.length} type${selected.length > 1 ? "s" : ""}`
            }
          >
            {allInteractionTypes.map((type) => (
              <MenuItem key={type} value={type}>
                <Checkbox checked={selectedTypes.indexOf(type) > -1} />
                <ListItemText primary={getInteractionTypeLabel(type)} />
              </MenuItem>
            ))}
          </Select>
        </FormControl>
        <Button
          size="small"
          variant="outlined"
          color="inherit"
          disabled={interactions.every((i) => !i.complete)}
          onClick={onClearCompleted}
          sx={{ whiteSpace: "nowrap", fontSize: "0.7rem" }}
        >
          Clear done
        </Button>
      </Box>

      <ExecutionTraceDialog
        open={traceDialogOpen}
        onClose={() => setTraceDialogOpen(false)}
        trace={selectedTrace}
        stats={selectedStats}
        from={selectedFrom}
        embeddedPaymentMethodFeePayer={selectedFeePayer}
      />
    </Box>
  );
}
