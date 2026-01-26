import { BackgroundConnectionHandler } from "@aztec/wallet-sdk/extension/handlers";
import {
  WalletMessageType,
  type WalletResponse,
} from "@aztec/wallet-sdk/types";
import { ChunkReassembler } from "../utils/chunk_reassembler";

// Wallet configuration
const WALLET_ID = "aztec-keychain";
const WALLET_NAME = "Aztec Keychain";
const WALLET_VERSION = "1.0.0";
const NATIVE_HOST_NAME = "com.aztec.keychain";

// Storage key for remembered apps
const REMEMBERED_APPS_KEY = "rememberedApps";

// Popup message types
enum PopupMessageType {
  GET_STATUS = "get-status",
  FOCUS_APP = "focus-app",
  GET_PENDING_DISCOVERIES = "get-pending-discoveries",
  GET_SESSIONS = "get-sessions",
  APPROVE_DISCOVERY = "approve-discovery",
  REJECT_DISCOVERY = "reject-discovery",
  DISCONNECT_SESSION = "disconnect-session",
  GET_REMEMBERED_APPS = "get-remembered-apps",
  FORGET_APP = "forget-app",
}

/**
 * A remembered app entry - stores appId + origin + network info for auto-approval.
 * Network info ensures apps are only auto-approved for the same network they were
 * originally approved on.
 */
interface RememberedApp {
  appId: string;
  origin: string;
  rememberedAt: number;
  /** Chain ID as hex string */
  chainId: string;
  /** Network version as hex string */
  version: string;
}

/**
 * Tracks pending requests by messageId -> sessionId.
 * Used to route native messaging responses back to the correct session.
 */
const pendingRequests = new Map<string, string>();
const chunkReassembler = new ChunkReassembler();

export default defineBackground(async () => {
  let nativePort: browser.runtime.Port | null = null;
  let backendConnected = false;

  // Storage helper functions (must be inside defineBackground for browser API access)
  async function getRememberedApps(): Promise<RememberedApp[]> {
    if (!browser?.storage?.local) {
      console.warn("browser.storage.local not available yet");
      return [];
    }
    const result = await browser.storage.local.get(REMEMBERED_APPS_KEY);
    const apps =
      (result[REMEMBERED_APPS_KEY] as RememberedApp[] | undefined) ?? [];
    // Filter out old format entries that don't have chainId/version
    return apps.filter((app) => app.chainId && app.version);
  }

  async function isAppRemembered(
    appId: string,
    origin: string,
    chainId: string,
    version: string,
  ): Promise<boolean> {
    const apps = await getRememberedApps();
    return apps.some(
      (app) =>
        app.appId === appId &&
        app.origin === origin &&
        app.chainId === chainId &&
        app.version === version,
    );
  }

  async function rememberApp(
    appId: string,
    origin: string,
    chainId: string,
    version: string,
  ): Promise<void> {
    if (!browser?.storage?.local) return;
    const apps = await getRememberedApps();
    if (
      !apps.some(
        (app) =>
          app.appId === appId &&
          app.origin === origin &&
          app.chainId === chainId &&
          app.version === version,
      )
    ) {
      apps.push({ appId, origin, rememberedAt: Date.now(), chainId, version });
      await browser.storage.local.set({ [REMEMBERED_APPS_KEY]: apps });
    }
  }

  async function forgetApp(
    appId: string,
    origin: string,
    chainId: string,
    version: string,
  ): Promise<void> {
    if (!browser?.storage?.local) return;
    const apps = await getRememberedApps();
    // Forget only the specific network entry for this appId+origin
    const filtered = apps.filter(
      (app) =>
        !(
          app.appId === appId &&
          app.origin === origin &&
          app.chainId === chainId &&
          app.version === version
        ),
    );
    await browser.storage.local.set({ [REMEMBERED_APPS_KEY]: filtered });
  }

  // Create session handler with transport and event callbacks
  const sessionHandler = new BackgroundConnectionHandler(
    {
      walletId: WALLET_ID,
      walletName: WALLET_NAME,
      walletVersion: WALLET_VERSION,
    },
    {
      sendToTab: (tabId, message) => browser.tabs.sendMessage(tabId, message),
      addContentListener: (handler) =>
        browser.runtime.onMessage.addListener(handler),
    },
    {
      onPendingDiscovery: (discovery) => {
        console.log(
          `Discovery request stored (pending approval): ${discovery.origin} (${discovery.requestId}), appId: ${discovery.appId}`,
        );

        // Extract chainInfo as strings for storage lookup
        const chainId = discovery.chainInfo.chainId.toString();
        const version = discovery.chainInfo.version.toString();

        // Check if app is remembered for this specific network - if so, auto-approve
        isAppRemembered(
          discovery.appId,
          discovery.origin,
          chainId,
          version,
        ).then((remembered) => {
          if (remembered) {
            const success = sessionHandler.approveDiscovery(
              discovery.requestId,
            );
            if (success) {
              console.log(
                `Auto-approved discovery for remembered app: ${discovery.appId} @ ${discovery.origin} (chain: ${chainId})`,
              );
              updateBadge();
            }
          } else {
            // Not a trusted app for this network - update badge and open popup for user approval
            updateBadge();
            browser.action.openPopup().catch(() => {
              // openPopup() may fail if popup is already open or browser doesn't support it
            });
          }
        });
      },
      onSessionEstablished: (session) => {
        console.log(
          `Session established: ${session.origin} (${session.sessionId}), hash: ${session.verificationHash.slice(0, 8)}...`,
        );

        // Open popup so user can see the verification emojis
        browser.action.openPopup().catch(() => {
          // openPopup() may fail if popup is already open or browser doesn't support it
        });
      },
      onSessionTerminated: (sessionId) => {
        console.log(`Session terminated: ${sessionId}`);
        for (const [messageId, sessId] of pendingRequests.entries()) {
          if (sessId === sessionId) {
            pendingRequests.delete(messageId);
          }
        }
      },
      onWalletMessage: (session, message) => {
        console.log("Processing RPC call:", message.type);

        if (nativePort) {
          pendingRequests.set(message.messageId, session.sessionId);
          nativePort.postMessage(message);
        } else {
          sessionHandler.sendResponse(session.sessionId, {
            messageId: message.messageId,
            walletId: WALLET_ID,
            error: { message: "Wallet backend not connected" },
          });
        }
      },
    },
  );

  sessionHandler.initialize();

  function getStatus() {
    return {
      connected: backendConnected,
      walletId: WALLET_ID,
      walletName: WALLET_NAME,
      walletVersion: WALLET_VERSION,
    };
  }

  function broadcastStatus() {
    browser.runtime
      .sendMessage({
        origin: "background",
        type: "status-update",
        status: getStatus(),
      })
      .catch(() => {});
  }

  function updateBadge() {
    const pendingDiscoveries = sessionHandler.getPendingDiscoveryCount();
    if (pendingDiscoveries > 0) {
      browser.action.setBadgeText({ text: String(pendingDiscoveries) });
      browser.action.setBadgeBackgroundColor({ color: "#ff9800" });
    } else {
      browser.action.setBadgeText({ text: "" });
    }
  }

  // Clean up when tabs close or navigate
  browser.tabs.onRemoved.addListener((tabId) => {
    sessionHandler.terminateForTab(tabId);
  });

  browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === "loading") {
      sessionHandler.terminateForTab(tabId);
    }
  });

  function handlePopupMessage(
    type: PopupMessageType,
    event: any,
    sendResponse: (response: any) => void,
  ): boolean {
    switch (type) {
      case PopupMessageType.GET_STATUS:
        sendResponse(getStatus());
        return false;

      case PopupMessageType.FOCUS_APP:
        if (nativePort && backendConnected) {
          nativePort.postMessage({ type: "focus-app" });
          sendResponse({ success: true });
        } else {
          sendResponse({ success: false, error: "Backend not connected" });
        }
        return false;

      case PopupMessageType.GET_PENDING_DISCOVERIES: {
        const discoveries = sessionHandler.getPendingDiscoveries().map((d) => ({
          requestId: d.requestId,
          appId: d.appId,
          appName: d.appName,
          origin: d.origin,
          timestamp: d.timestamp,
          status: d.status,
          chainId: d.chainInfo.chainId.toString(),
          version: d.chainInfo.version.toString(),
        }));
        sendResponse(discoveries);
        return false;
      }

      case PopupMessageType.GET_SESSIONS: {
        const sessions = sessionHandler.getActiveSessions().map((s) => ({
          sessionId: s.sessionId,
          origin: s.origin,
          verificationHash: s.verificationHash,
          connectedAt: s.connectedAt,
          appId: s.appId,
          chainId: s.chainInfo.chainId.toString(),
          version: s.chainInfo.version.toString(),
        }));
        sendResponse(sessions);
        return false;
      }

      case PopupMessageType.APPROVE_DISCOVERY: {
        // Get the discovery before approving so we can remember it
        const discovery = sessionHandler
          .getPendingDiscoveries()
          .find((d) => d.requestId === event.requestId);

        const success = sessionHandler.approveDiscovery(event.requestId);
        if (success && discovery) {
          // Remember the app when user explicitly approves (not on session established)
          const chainId = discovery.chainInfo.chainId.toString();
          const version = discovery.chainInfo.version.toString();
          rememberApp(discovery.appId, discovery.origin, chainId, version);

          console.log(`Discovery ${event.requestId} approved by user`);
          updateBadge();
          sendResponse({ success: true });
        } else {
          sendResponse({
            success: false,
            error: "Discovery not found or not pending",
          });
        }
        return false;
      }

      case PopupMessageType.REJECT_DISCOVERY: {
        const success = sessionHandler.rejectDiscovery(event.requestId);
        if (success) {
          console.log(`Discovery ${event.requestId} rejected by user`);
          updateBadge();
          sendResponse({ success: true });
        } else {
          sendResponse({
            success: false,
            error: "Discovery not found or not pending",
          });
        }
        return false;
      }

      case PopupMessageType.DISCONNECT_SESSION: {
        const session = sessionHandler.getSession(event.sessionId);
        if (session) {
          sessionHandler.sendResponse(session.sessionId, {
            messageId: "disconnect",
            walletId: WALLET_ID,
            error: {
              type: WalletMessageType.SESSION_DISCONNECTED,
              message: "Disconnected by user",
            },
          });
          sessionHandler.terminateSession(event.sessionId);
          console.log(`Session ${event.sessionId} disconnected by user`);
          sendResponse({ success: true });
        } else {
          sendResponse({
            success: false,
            error: "Session not found",
          });
        }
        return false;
      }

      case PopupMessageType.GET_REMEMBERED_APPS: {
        getRememberedApps().then((apps) => sendResponse(apps));
        return true; // Keep channel open for async response
      }

      case PopupMessageType.FORGET_APP: {
        forgetApp(event.appId, event.appOrigin, event.chainId, event.version).then(() => {
          console.log(`Forgot app: ${event.appId} @ ${event.appOrigin} (chain: ${event.chainId})`);
          sendResponse({ success: true });
        });
        return true; // Keep channel open for async response
      }

      default:
        return false;
    }
  }

  // Handle messages from popup (content script messages are handled by SDK)
  browser.runtime.onMessage.addListener((event: any, _sender, sendResponse) => {
    if (event.origin === "popup") {
      return handlePopupMessage(
        event.type as PopupMessageType,
        event,
        sendResponse,
      );
    }
  });

  function connect() {
    try {
      console.log(`Extension ID: ${browser.runtime.id}`);
      console.log(`Attempting to connect to native host: ${NATIVE_HOST_NAME}`);

      nativePort = browser.runtime.connectNative(NATIVE_HOST_NAME);

      nativePort.onMessage.addListener((rawResponse: any) => {
        const response = chunkReassembler.process<any>(rawResponse);
        if (!response) {
          return;
        }

        if (response.type === "status") {
          backendConnected = response.status === "connected";
          console.log(`Backend connection status: ${backendConnected}`);
          broadcastStatus();
          return;
        }

        const sessionId = pendingRequests.get(response.messageId);
        if (!sessionId) {
          console.error(
            `No pending request found for messageId ${response.messageId}`,
          );
          return;
        }
        pendingRequests.delete(response.messageId);

        if (!response.walletId) {
          response.walletId = WALLET_ID;
        }

        sessionHandler.sendResponse(sessionId, response as WalletResponse);
      });

      nativePort.onDisconnect.addListener(() => {
        const error = browser.runtime.lastError;
        if (error) {
          console.error(
            `Native host disconnected with error: ${error.message}`,
          );
        } else {
          console.log("Native host disconnected");
        }
        nativePort = null;
        backendConnected = false;

        const sessionCount = sessionHandler.getActiveSessions().length;
        const pendingCount = sessionHandler.getPendingDiscoveryCount();
        if (sessionCount > 0 || pendingCount > 0) {
          console.log(
            `Pruning ${sessionCount} sessions and ${pendingCount} pending discoveries due to backend disconnect`,
          );

          // Send disconnect notification to all sessions
          for (const session of sessionHandler.getActiveSessions()) {
            sessionHandler.sendResponse(session.sessionId, {
              messageId: "disconnect",
              walletId: WALLET_ID,
              error: {
                type: WalletMessageType.SESSION_DISCONNECTED,
                message: "Wallet backend disconnected",
              },
            });
          }

          sessionHandler.clearAll();
          pendingRequests.clear();
        }

        broadcastStatus();
        setTimeout(connect, 1000);
      });

      console.log("Connected to native messaging host");
      broadcastStatus();

      setInterval(() => chunkReassembler.cleanup(), 10000);
    } catch (err) {
      console.error("Failed to connect to native host:", err);
      nativePort = null;
      setTimeout(connect, 1000);
    }
  }

  connect();
});
