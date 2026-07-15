import React, { useContext, useEffect, useRef, useState } from "react";
import Box from "@mui/material/Box";
import AppBar from "@mui/material/AppBar";
import Toolbar from "@mui/material/Toolbar";
import IconButton from "@mui/material/IconButton";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import MenuIcon from "@mui/icons-material/Menu";
import Typography from "@mui/material/Typography";
import List from "@mui/material/List";
import ListItem from "@mui/material/ListItem";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemText from "@mui/material/ListItemText";
import AccountBalanceWalletIcon from "@mui/icons-material/AccountBalanceWallet";
import ContactsIcon from "@mui/icons-material/Contacts";
import AppsIcon from "@mui/icons-material/Apps";
import { useTheme } from "@mui/material/styles";
import useMediaQuery from "@mui/material/useMediaQuery";
import { InteractionsList } from "./components/sections/interactions/index.tsx";
import { AccountsManager } from "./components/sections/accounts/index.tsx";
import { ContactsManager } from "./components/sections/contacts/index.tsx";
import { AuthorizedApps } from "./components/sections/authorized-apps/index.tsx";
import { AuthorizationDialog } from "./components/dialogs/AuthorizationDialog.tsx";
import { ProofDebugExportDialog } from "./components/dialogs/ProofDebugExportDialog.tsx";
import { HandshakeRelayDialog } from "./components/dialogs/HandshakeRelayDialog.tsx";
import { NetworkSelector } from "./components/NetworkSelector.tsx";
import { TxProgressTimeline } from "./components/shared/TxProgressTimeline.tsx";
import type { ProofDebugExportRequest } from "../wallet/types/wallet-interaction.ts";

import type {
  WalletInteraction,
  WalletInteractionType,
} from "../wallet/types/wallet-interaction.ts";
import type { AuthorizationRequest } from "../wallet/types/authorization.ts";
import type { HandshakeRelayRequest, HandshakeRelayResponse } from "../wallet/types/handshake.ts";
import { WalletContext } from "./renderer.tsx";
import { useNetwork } from "./contexts/NetworkContext.tsx";
import { AZTEC_SDK_VERSION } from "./utils/version.ts";

const INTERACTIONS_PANEL_WIDTH = 400;
const INTERACTIONS_PANEL_MIN_WIDTH = 300;
const INTERACTIONS_PANEL_MAX_WIDTH = 800;
const MENU_DRAWER_WIDTH = 240;
const SIDEBAR_WIDTH = 64;

type MenuSection = "accounts" | "contacts" | "apps";
type CompactTab = MenuSection | "interactions";

export function App() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [currentSection, setCurrentSection] = useState<MenuSection>("accounts");
  const [interactionsPanelWidth, setInteractionsPanelWidth] = useState(INTERACTIONS_PANEL_WIDTH);
  const [isResizing, setIsResizing] = useState(false);
  const [compactTab, setCompactTab] = useState<CompactTab>("accounts");

  // Track when each phase begins per interaction (interactionId:STATUS → timestamp)
  const phaseStartsRef = useRef<Map<string, number>>(new Map());

  const [interactions, setInteractions] = useState<WalletInteraction<WalletInteractionType>[]>([]);
  const [selectedInteractionTypes, setSelectedInteractionTypes] = useState<WalletInteractionType[]>(
    [
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
    ],
  );

  const [authQueue, setAuthQueue] = useState<AuthorizationRequest[]>([]);
  const currentAuth = authQueue[0] || null;

  const [proofDebugExportRequest, setProofDebugExportRequest] = useState<
    (ProofDebugExportRequest & { debugData: string }) | null
  >(null);

  const [handshakeRelay, setHandshakeRelay] = useState<HandshakeRelayRequest | null>(null);

  const { walletAPI } = useContext(WalletContext);
  const { currentNetwork } = useNetwork();

  // Responsive breakpoints — all hooks called unconditionally (Rules of Hooks)
  const theme = useTheme();
  const isSmallWidth = useMediaQuery(theme.breakpoints.down("md"));
  const isSmallHeight = useMediaQuery("(max-height: 499.95px)");
  const isCompact = isSmallWidth || isSmallHeight;

  const loadInteractions = async () => {
    const interactions = await walletAPI.getInteractions();
    setInteractions(interactions);
  };

  useEffect(() => {
    // Clear state when network changes
    setInteractions([]);
    setAuthQueue([]);
    setCompactTab("accounts");
    setHandshakeRelay(null);
    phaseStartsRef.current.clear();

    loadInteractions();
    const unsubWalletUpdate = walletAPI.onWalletUpdate((interaction) => {
      // Always record when each phase begins (overwrite on re-runs of same interaction id,
      // e.g. recurring simulateUtility calls that share the same payloadHash as id).
      const phaseKey = `${interaction.id}:${interaction.status}`;
      phaseStartsRef.current.set(phaseKey, Date.now());
      // MINING is the live mining phase — also store as SENT so the timeline
      // can measure Sending duration (SENDING→SENT) and Mining elapsed (from SENT key).
      if (interaction.status === "MINING") {
        phaseStartsRef.current.set(`${interaction.id}:SENT`, Date.now());
      }
      // START uses interaction.timestamp (creation time) — only set once per id.
      const startKey = `${interaction.id}:START`;
      if (!phaseStartsRef.current.has(startKey)) {
        phaseStartsRef.current.set(startKey, interaction.timestamp);
      }

      // Skip internal-only events that shouldn't appear in the interactions list
      if ((interaction as any).type === "capabilityChange") return;

      setInteractions((prevEvents) => {
        const eventsMap = new Map<string, WalletInteraction<WalletInteractionType>>(
          prevEvents.map((e) => [e.id, e]),
        );
        eventsMap.set(interaction.id, interaction);
        return Array.from(eventsMap.values()).sort((a, b) => b.timestamp - a.timestamp);
      });
    });

    const unsubAuthRequest = walletAPI.onAuthorizationRequest((request: AuthorizationRequest) => {
      console.log("New authorization request:", request);
      setAuthQueue((prev) => {
        if (prev.some((req) => req.id === request.id)) {
          return prev;
        }
        return [...prev, request];
      });
    });

    walletAPI.onProofDebugExportRequest(
      (request: ProofDebugExportRequest & { debugData: string }) => {
        console.log("Proof debug export request:", request.id);
        setProofDebugExportRequest(request);
      },
    );

    const unsubHandshakeRelay = walletAPI.onHandshakeRelayRequest(
      (request: HandshakeRelayRequest) => {
        console.log("Handshake relay request:", request.id);
        setHandshakeRelay(request);
      },
    );

    return () => {
      unsubWalletUpdate();
      unsubAuthRequest();
      unsubHandshakeRelay();
    };
  }, [currentNetwork.id, walletAPI]);

  const handleDismissInteraction = (id: string) => {
    walletAPI.deleteInteraction(id);
    setInteractions((prev) => prev.filter((i) => i.id !== id));
  };

  const handleClearCompleted = () => {
    const completedIds = interactions.filter((i) => i.complete).map((i) => i.id);
    walletAPI.clearInteractions();
    setInteractions((prev) => prev.filter((i) => !completedIds.includes(i.id)));
  };

  const handleMenuToggle = () => {
    setMenuOpen(!menuOpen);
  };

  const handleMenuItemClick = (section: MenuSection) => {
    setCurrentSection(section);
    setMenuOpen(false);
  };

  const handleAuthApprove = (itemResponses: Record<string, any>) => {
    if (currentAuth) {
      walletAPI.resolveAuthorization({
        id: currentAuth.id,
        approved: true,
        appId: currentAuth.appId,
        itemResponses,
      });
      setAuthQueue((prev) => prev.slice(1));
    }
  };

  const handleAuthDeny = () => {
    if (currentAuth) {
      const itemResponses: Record<string, any> = {};
      for (const item of currentAuth.items) {
        itemResponses[item.id] = {
          id: item.id,
          approved: false,
          appId: item.appId,
        };
      }

      walletAPI.resolveAuthorization({
        id: currentAuth.id,
        approved: false,
        appId: currentAuth.appId,
        itemResponses,
      });
      setAuthQueue((prev) => prev.slice(1));
    }
  };

  const handleProofDebugExport = async () => {
    if (proofDebugExportRequest) {
      const result = await (walletAPI as any).saveProofDebugData(proofDebugExportRequest.debugData);
      if (result?.success) {
        console.log("Debug data saved to:", result.filePath);
      } else if (result && !result.canceled) {
        console.error("Failed to save debug data:", result.error);
      }
      setProofDebugExportRequest(null);
    }
  };

  const handleProofDebugCancel = () => {
    setProofDebugExportRequest(null);
  };

  const handleHandshakeRelayResolve = (response: HandshakeRelayResponse) => {
    walletAPI.resolveHandshakeRelay(response);
    setHandshakeRelay(null);
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
  };

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing) return;

      const newWidth = window.innerWidth - e.clientX;
      if (newWidth >= INTERACTIONS_PANEL_MIN_WIDTH && newWidth <= INTERACTIONS_PANEL_MAX_WIDTH) {
        setInteractionsPanelWidth(newWidth);
      }
    };

    const handleMouseUp = () => {
      setIsResizing(false);
    };

    if (isResizing) {
      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
    }

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isResizing]);

  const renderSectionContent = (section: MenuSection) => {
    switch (section) {
      case "accounts":
        return <AccountsManager />;
      case "contacts":
        return <ContactsManager />;
      case "apps":
        return <AuthorizedApps />;
      default:
        return null;
    }
  };

  // Shared dialogs — rendered outside all layout branches
  const dialogs = (
    <>
      {currentAuth && (
        <AuthorizationDialog
          request={currentAuth}
          onApprove={handleAuthApprove}
          onDeny={handleAuthDeny}
          queueLength={authQueue.length}
          wide={!isCompact}
        />
      )}
      {proofDebugExportRequest && (
        <ProofDebugExportDialog
          request={proofDebugExportRequest}
          onExport={handleProofDebugExport}
          onCancel={handleProofDebugCancel}
        />
      )}
      {handshakeRelay && (
        <HandshakeRelayDialog request={handshakeRelay} onResolve={handleHandshakeRelayResolve} />
      )}
    </>
  );

  // ── Compact layout (< 700px wide OR < 500px tall) ──────────────────────────
  if (isCompact) {
    return (
      <Box
        sx={{
          display: "flex",
          flexDirection: "column",
          height: "100%",
          width: "100%",
          overflow: "hidden",
        }}
      >
        {/* Header row */}
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            px: 1,
            py: 0.5,
            borderBottom: 1,
            borderColor: "divider",
            bgcolor: "background.paper",
            gap: 1,
            flexShrink: 0,
          }}
        >
          <AccountBalanceWalletIcon fontSize="small" color="primary" />
          <Typography variant="caption" fontWeight="bold" sx={{ flexGrow: 1 }}>
            Demo Wallet
          </Typography>
          <NetworkSelector />
        </Box>

        {/* Section tabs */}
        <Box
          sx={{
            display: "flex",
            borderBottom: 1,
            borderColor: "divider",
            bgcolor: "background.paper",
            flexShrink: 0,
          }}
        >
          {(["accounts", "contacts", "apps", "interactions"] as CompactTab[]).map((tab) => (
            <Box
              key={tab}
              onClick={() => {
                setCompactTab(tab);
                if (tab !== "interactions") {
                  setCurrentSection(tab as MenuSection);
                }
              }}
              sx={{
                flex: 1,
                py: 0.75,
                textAlign: "center",
                cursor: "pointer",
                borderBottom: compactTab === tab ? 2 : 0,
                borderColor: "primary.main",
                bgcolor: compactTab === tab ? "action.selected" : "transparent",
                "&:hover": { bgcolor: "action.hover" },
              }}
            >
              <Typography
                variant="caption"
                fontWeight={compactTab === tab ? "bold" : "normal"}
                sx={{ textTransform: "capitalize", fontSize: "0.65rem" }}
              >
                {tab}
              </Typography>
            </Box>
          ))}
        </Box>

        {/* Tab content */}
        <Box sx={{ flexGrow: 1, overflow: "auto", p: 1 }}>
          {compactTab === "interactions" ? (
            <InteractionsList
              interactions={interactions}
              selectedTypes={selectedInteractionTypes}
              onTypeFilterChange={setSelectedInteractionTypes}
              onDismiss={handleDismissInteraction}
              onClearCompleted={handleClearCompleted}
              phaseStartsRef={phaseStartsRef}
            />
          ) : (
            renderSectionContent(currentSection)
          )}
        </Box>

        {/* Active interaction banner — pinned at bottom, only when not on interactions tab */}
        {(() => {
          const active = interactions.find((i) => !i.complete);
          if (!active || compactTab === "interactions") return null;
          const hasTxTimeline =
            active.type === "sendTx" ||
            active.type === "simulateTx" ||
            active.type === "simulateUtility" ||
            active.type === "createAccount" ||
            active.type === "deployAccount";
          return (
            <Box
              onClick={() => setCompactTab("interactions")}
              sx={{
                flexShrink: 0,
                px: 1,
                py: 0.5,
                borderTop: 1,
                borderColor: "primary.main",
                bgcolor: "rgba(25, 118, 210, 0.08)",
                cursor: "pointer",
                "&:hover": { bgcolor: "rgba(25, 118, 210, 0.14)" },
              }}
            >
              <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                <CircularProgress size={12} thickness={5} sx={{ flexShrink: 0 }} />
                <Typography
                  variant="caption"
                  sx={{
                    flexGrow: 1,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    fontSize: "0.65rem",
                  }}
                >
                  {active.title}
                </Typography>
                <Chip
                  label={active.status}
                  size="small"
                  color="primary"
                  sx={{ height: 16, fontSize: "0.6rem", flexShrink: 0 }}
                />
              </Box>
              {hasTxTimeline && (
                <TxProgressTimeline interaction={active} phaseStartsRef={phaseStartsRef} />
              )}
            </Box>
          );
        })()}

        {dialogs}
      </Box>
    );
  }

  // ── Full layout (≥ 700px wide) — unchanged ─────────────────────────────────
  return (
    <Box
      sx={{
        display: "flex",
        height: "100%",
        overflow: "hidden",
        width: "100%",
        cursor: isResizing ? "col-resize" : "default",
        userSelect: isResizing ? "none" : "auto",
      }}
    >
      {/* Combined Sidebar - Expands when menu opens */}
      <Box
        sx={{
          width: menuOpen ? SIDEBAR_WIDTH + MENU_DRAWER_WIDTH : SIDEBAR_WIDTH,
          flexShrink: 0,
          borderRight: 1,
          borderColor: "divider",
          display: "flex",
          bgcolor: "background.paper",
          transition: "width 225ms cubic-bezier(0.4, 0, 0.6, 1)",
          overflow: "hidden",
        }}
      >
        {/* Icon Sidebar - Always visible */}
        <Box
          sx={{
            width: SIDEBAR_WIDTH,
            flexShrink: 0,
            display: "flex",
            flexDirection: "column",
            borderRight: menuOpen ? 1 : 0,
            borderColor: "divider",
          }}
        >
          <Box
            sx={{
              height: 64,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              borderBottom: 1,
              borderColor: "divider",
            }}
          >
            <IconButton color="primary" aria-label="open menu" onClick={handleMenuToggle}>
              <MenuIcon />
            </IconButton>
          </Box>
          <List sx={{ p: 0 }}>
            <ListItem disablePadding>
              <ListItemButton
                selected={currentSection === "accounts"}
                onClick={() => handleMenuItemClick("accounts")}
                sx={{
                  flexDirection: "column",
                  py: 2,
                  minHeight: SIDEBAR_WIDTH,
                }}
              >
                <AccountBalanceWalletIcon />
              </ListItemButton>
            </ListItem>
            <ListItem disablePadding>
              <ListItemButton
                selected={currentSection === "contacts"}
                onClick={() => handleMenuItemClick("contacts")}
                sx={{
                  flexDirection: "column",
                  py: 2,
                  minHeight: SIDEBAR_WIDTH,
                }}
              >
                <ContactsIcon />
              </ListItemButton>
            </ListItem>
            <ListItem disablePadding>
              <ListItemButton
                selected={currentSection === "apps"}
                onClick={() => handleMenuItemClick("apps")}
                sx={{
                  flexDirection: "column",
                  py: 2,
                  minHeight: SIDEBAR_WIDTH,
                }}
              >
                <AppsIcon />
              </ListItemButton>
            </ListItem>
          </List>
        </Box>

        {/* Expanded Menu Content */}
        <Box
          sx={{
            width: MENU_DRAWER_WIDTH,
            display: "flex",
            flexDirection: "column",
            opacity: menuOpen ? 1 : 0,
            transition: "opacity 225ms cubic-bezier(0.4, 0, 0.6, 1)",
          }}
        >
          <Box
            sx={{
              height: 64,
              display: "flex",
              alignItems: "center",
              px: 2,
              borderBottom: 1,
              borderColor: "divider",
            }}
          >
            <Typography variant="h6">Menu</Typography>
          </Box>
          <Box sx={{ overflowY: "auto" }}>
            <List sx={{ padding: 0 }}>
              <ListItem disablePadding>
                <ListItemButton
                  sx={{ height: 64 }}
                  selected={currentSection === "accounts"}
                  onClick={() => handleMenuItemClick("accounts")}
                >
                  <ListItemText primary="Accounts" />
                </ListItemButton>
              </ListItem>
              <ListItem disablePadding>
                <ListItemButton
                  sx={{ height: 64 }}
                  selected={currentSection === "contacts"}
                  onClick={() => handleMenuItemClick("contacts")}
                >
                  <ListItemText primary="Contacts" />
                </ListItemButton>
              </ListItem>
              <ListItem disablePadding>
                <ListItemButton
                  sx={{ height: 64 }}
                  selected={currentSection === "apps"}
                  onClick={() => handleMenuItemClick("apps")}
                >
                  <ListItemText primary="Apps" />
                </ListItemButton>
              </ListItem>
            </List>
          </Box>
          {/* Version footer: the Aztec SDK version the wallet is built against */}
          <Box
            sx={{
              mt: "auto",
              px: 2,
              py: 1.5,
              borderTop: 1,
              borderColor: "divider",
            }}
          >
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ display: "block", lineHeight: 1.4 }}
            >
              Aztec SDK
            </Typography>
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{
                display: "block",
                fontFamily: "monospace",
                wordBreak: "break-all",
                lineHeight: 1.4,
              }}
            >
              {AZTEC_SDK_VERSION}
            </Typography>
          </Box>
        </Box>
      </Box>

      {/* Main Content Area with App Bar */}
      <Box
        sx={{
          flexGrow: 1,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        {/* App Bar */}
        <AppBar position="static">
          <Toolbar>
            <Typography variant="h6" component="h1" sx={{ flexGrow: 1 }}>
              Demo Wallet
            </Typography>
            <NetworkSelector />
          </Toolbar>
        </AppBar>

        {/* Main Content */}
        <Box
          component="main"
          sx={{
            flexGrow: 1,
            p: 3,
            overflow: "hidden",
            width: "100%",
            display: "flex",
          }}
        >
          {renderSectionContent(currentSection)}
        </Box>
      </Box>

      {/* Fixed Right Interactions Panel */}
      <Box
        sx={{
          width: interactionsPanelWidth,
          flexShrink: 0,
          display: "flex",
          flexDirection: "column",
          bgcolor: "background.paper",
          position: "relative",
        }}
      >
        {/* Resize Handle */}
        <Box
          onMouseDown={handleMouseDown}
          sx={{
            position: "absolute",
            left: 0,
            top: 0,
            bottom: 0,
            width: 4,
            cursor: "col-resize",
            bgcolor: "divider",
            transition: "background-color 0.2s",
            "&:hover": {
              bgcolor: "primary.main",
            },
            ...(isResizing && {
              bgcolor: "primary.main",
            }),
          }}
        />
        <Box sx={{ p: 2, borderBottom: 1, borderColor: "divider", borderLeft: 1 }}>
          <Typography variant="h6" component="h2">
            Interactions
          </Typography>
        </Box>
        <Box
          sx={{
            flexGrow: 1,
            overflow: "auto",
            borderLeft: 1,
            borderColor: "divider",
          }}
        >
          <InteractionsList
            interactions={interactions}
            selectedTypes={selectedInteractionTypes}
            onTypeFilterChange={setSelectedInteractionTypes}
            onDismiss={handleDismissInteraction}
            onClearCompleted={handleClearCompleted}
            phaseStartsRef={phaseStartsRef}
          />
        </Box>
      </Box>

      {dialogs}
    </Box>
  );
}
