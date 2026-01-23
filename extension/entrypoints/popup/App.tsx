import { useEffect, useState } from "react";
import { hashToEmoji } from "@aztec/wallet-sdk/crypto";
import "./App.css";

type Tab = "activity" | "settings";

interface WalletStatus {
  connected: boolean;
  walletId: string;
  walletName: string;
  walletVersion: string;
}

/**
 * Pending discovery request - before user approval.
 * No verification emoji at this stage (no keys exchanged yet).
 */
interface PendingDiscovery {
  requestId: string;
  appId: string;
  appName?: string;
  origin: string;
  timestamp: number;
  /** Chain ID as hex string */
  chainId: string;
  /** Network version as hex string */
  version: string;
}

/**
 * Active session - established after key exchange.
 */
interface ActiveSession {
  requestId: string;
  verificationHash: string;
  origin: string;
  connectedAt: number;
  appId?: string;
  /** Chain ID as hex string */
  chainId: string;
  /** Network version as hex string */
  version: string;
}

/**
 * Remembered app - auto-approves discovery requests.
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
 * Safely extracts hostname from an origin URL.
 * Returns the origin string itself if parsing fails.
 */
function getHostname(origin: string): string {
  if (!origin) return "unknown";
  try {
    return new URL(origin).hostname;
  } catch {
    return origin;
  }
}

/**
 * Renders a 3x3 emoji grid for verification display.
 * Takes a string of 9 emojis and splits them into 3 rows.
 */
function EmojiGrid({ emojis }: { emojis: string }): JSX.Element {
  // Split emojis into array (handles multi-byte emoji correctly)
  const emojiArray = [...emojis];
  const rows = [
    emojiArray.slice(0, 3),
    emojiArray.slice(3, 6),
    emojiArray.slice(6, 9),
  ];

  return (
    <div className="emoji-grid">
      {rows.map((row, i) => (
        <div key={i} className="emoji-row">
          {row.map((emoji, j) => (
            <span key={j} className="emoji-cell">{emoji}</span>
          ))}
        </div>
      ))}
    </div>
  );
}

/**
 * Converts a hex string (with or without 0x prefix) to decimal string.
 */
function hexToDecimal(hex: string): string {
  try {
    // Remove 0x prefix if present
    const cleanHex = hex.startsWith("0x") ? hex.slice(2) : hex;
    // Use BigInt for large numbers
    return BigInt("0x" + cleanHex).toString(10);
  } catch {
    return hex; // Return original if conversion fails
  }
}

/**
 * Checks if the appId roughly matches the origin domain.
 * Returns true if they appear to match, false if there's a potential mismatch.
 */
function domainsMatch(origin: string, appId?: string): boolean {
  if (!appId || !origin) return true; // No appId or origin yet, can't check

  try {
    const hostname = getHostname(origin);
    const normalizedAppId = appId.toLowerCase().replace(/[^a-z0-9.-]/g, "");
    const normalizedHostname = hostname.toLowerCase();

    // Check if appId contains the hostname or vice versa
    // e.g., "myapp.com" matches "app.myapp.com" or "myapp"
    const hostParts = normalizedHostname.split(".");
    const appParts = normalizedAppId.split(".");

    // Check if any significant part matches
    for (const hostPart of hostParts) {
      if (hostPart.length > 2 && normalizedAppId.includes(hostPart)) {
        return true;
      }
    }
    for (const appPart of appParts) {
      if (appPart.length > 2 && normalizedHostname.includes(appPart)) {
        return true;
      }
    }

    // Also check if appId is a substring of hostname or vice versa
    if (
      normalizedHostname.includes(normalizedAppId) ||
      normalizedAppId.includes(normalizedHostname)
    ) {
      return true;
    }

    return false;
  } catch {
    return true; // If parsing fails, don't show warning
  }
}

function App() {
  const [status, setStatus] = useState<WalletStatus | null>(null);
  const [pendingDiscoveries, setPendingDiscoveries] = useState<PendingDiscovery[]>([]);
  const [sessions, setSessions] = useState<ActiveSession[]>([]);
  const [rememberedApps, setRememberedApps] = useState<RememberedApp[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<Tab>("activity");
  const [currentTabOrigin, setCurrentTabOrigin] = useState<string | null>(null);

  const refreshData = async () => {
    const [discoveriesResponse, sessionsResponse, rememberedResponse] = await Promise.all([
      browser.runtime.sendMessage({
        origin: "popup",
        type: "get-pending-discoveries",
      }),
      browser.runtime.sendMessage({
        origin: "popup",
        type: "get-sessions",
      }),
      browser.runtime.sendMessage({
        origin: "popup",
        type: "get-remembered-apps",
      }),
    ]);
    setPendingDiscoveries(discoveriesResponse || []);
    setSessions(sessionsResponse || []);
    setRememberedApps(rememberedResponse || []);
  };

  const handleApprove = async (requestId: string) => {
    await browser.runtime.sendMessage({
      origin: "popup",
      type: "approve-discovery",
      requestId,
    });
    await refreshData();
  };

  const handleReject = async (requestId: string) => {
    await browser.runtime.sendMessage({
      origin: "popup",
      type: "reject-discovery",
      requestId,
    });
    await refreshData();
  };

  const handleDisconnect = async (requestId: string) => {
    await browser.runtime.sendMessage({
      origin: "popup",
      type: "disconnect-session",
      requestId,
    });
    await refreshData();
  };

  const handleForgetApp = async (appId: string, appOrigin: string) => {
    await browser.runtime.sendMessage({
      origin: "popup",
      type: "forget-app",
      appId,
      appOrigin,
    });
    await refreshData();
  };

  const handleOpenApp = async () => {
    await browser.runtime.sendMessage({
      origin: "popup",
      type: "focus-app",
    });
  };

  useEffect(() => {
    // Get the current active tab's origin
    browser.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
      if (tabs[0]?.url) {
        try {
          const origin = new URL(tabs[0].url).origin;
          setCurrentTabOrigin(origin);
        } catch {
          // Ignore invalid URLs (e.g., chrome:// pages)
        }
      }
    });

    // Get initial status, pending discoveries, active sessions, and remembered apps
    Promise.all([
      browser.runtime.sendMessage({ origin: "popup", type: "get-status" }),
      browser.runtime.sendMessage({ origin: "popup", type: "get-pending-discoveries" }),
      browser.runtime.sendMessage({ origin: "popup", type: "get-sessions" }),
      browser.runtime.sendMessage({ origin: "popup", type: "get-remembered-apps" }),
    ])
      .then(([statusResponse, discoveriesResponse, sessionsResponse, rememberedResponse]) => {
        setStatus(statusResponse);
        setPendingDiscoveries(discoveriesResponse || []);
        setSessions(sessionsResponse || []);
        setRememberedApps(rememberedResponse || []);
        setLoading(false);
      })
      .catch((err) => {
        console.error("Failed to get status:", err);
        setLoading(false);
      });

    // Listen for status updates from background
    const handleMessage = (event: any) => {
      if (event.origin === "background" && event.type === "status-update") {
        setStatus(event.status);
        // Refresh data when status changes (e.g., backend disconnect clears sessions)
        refreshData();
      }
    };

    browser.runtime.onMessage.addListener(handleMessage);
    return () => browser.runtime.onMessage.removeListener(handleMessage);
  }, []);

  // Count of activity items requiring attention (only pending discoveries now)
  const activityCount = pendingDiscoveries.length;

  return (
    <div className="popup-container">
      <header className="popup-header">
        <div className="header-left">
          <svg
            className="logo"
            viewBox="0 0 24 24"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
          >
            <path
              d="M12 2L2 7L12 12L22 7L12 2Z"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d="M2 17L12 22L22 17"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d="M2 12L12 17L22 12"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <span className="title">Keychain</span>
        </div>
        <div className="header-right">
          {status && (
            <>
              <span
                className={`status-dot ${status.connected ? "connected" : "disconnected"}`}
                title={status.connected ? "Backend connected" : "Backend disconnected"}
              />
              {status.connected && (
                <button className="btn-open-app" onClick={handleOpenApp} title="Open App">
                  ↗
                </button>
              )}
            </>
          )}
        </div>
      </header>

      {/* Tab Navigation */}
      <nav className="tab-nav">
        <button
          className={`tab-btn ${activeTab === "activity" ? "active" : ""}`}
          onClick={() => setActiveTab("activity")}
        >
          Activity
          {activityCount > 0 && <span className="tab-badge">{activityCount}</span>}
        </button>
        <button
          className={`tab-btn ${activeTab === "settings" ? "active" : ""}`}
          onClick={() => setActiveTab("settings")}
        >
          Settings
        </button>
      </nav>

      <main className="popup-main">
        {loading ? (
          <div className="loading-container">
            <div className="spinner" />
            <span>Loading...</span>
          </div>
        ) : status ? (
          <>
            {activeTab === "activity" && (
              <>
                {/* Pending Discovery Requests - No verification emoji yet */}
                {pendingDiscoveries.length > 0 && (
                  <div className="section pending">
                    <h3 className="section-title">Connection Requests</h3>
                    <div className="item-list">
                      {pendingDiscoveries.map((d) => {
                        const hostname = getHostname(d.origin);
                        const mismatch = !domainsMatch(d.origin, d.appId);
                        return (
                          <div key={d.requestId} className="item pending-discovery">
                            <div className="item-info">
                              <span className="item-name">
                                {d.appName || d.appId || hostname}
                                {mismatch && (
                                  <span
                                    className="item-warning"
                                    title={`App ID "${d.appId}" doesn't match domain "${hostname}"`}
                                  >
                                    ⚠️
                                  </span>
                                )}
                              </span>
                              {d.appId && d.appId !== hostname && (
                                <span className="item-origin">via {hostname}</span>
                              )}
                              <span className="item-chain-info">
                                <span className="item-chain" title={`Chain ID (hex): ${d.chainId}`}>
                                  Chain: {hexToDecimal(d.chainId)}
                                </span>
                                <span className="item-chain" title={`Version (hex): ${d.version}`}>
                                  Version: {hexToDecimal(d.version)}
                                </span>
                              </span>
                            </div>
                            <div className="item-actions">
                              <button
                                className="btn btn-approve"
                                onClick={() => handleApprove(d.requestId)}
                              >
                                Allow
                              </button>
                              <button
                                className="btn btn-reject"
                                onClick={() => handleReject(d.requestId)}
                              >
                                Deny
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Active Sessions */}
                {sessions.length > 0 && (
                  <div className="section active">
                    <h3 className="section-title">Connected</h3>
                    <div className="item-list">
                      {sessions.map((s) => {
                        const hostname = getHostname(s.origin);
                        const mismatch = !domainsMatch(s.origin, s.appId);
                        const isCurrentTab = currentTabOrigin === s.origin;
                        return (
                          <div key={s.requestId} className={`item session session-card ${isCurrentTab ? 'current-tab' : ''}`}>
                            <div className="session-header">
                              <span className="item-name">
                                {s.appId || hostname}
                                {mismatch && (
                                  <span
                                    className="item-warning"
                                    title={`App ID "${s.appId}" doesn't match domain "${hostname}"`}
                                  >
                                    ⚠️
                                  </span>
                                )}
                              </span>
                              <button
                                className="btn-icon btn-disconnect"
                                onClick={() => handleDisconnect(s.requestId)}
                                title="Disconnect"
                              >
                                ✕
                              </button>
                            </div>
                            <div className="session-content">
                              <div className="session-info">
                                {s.appId && s.appId !== hostname && (
                                  <span className="item-origin">via {hostname}</span>
                                )}
                                <span className="item-chain-info">
                                  <span className="item-chain" title={`Chain ID (hex): ${s.chainId}`}>
                                    Chain: {hexToDecimal(s.chainId)}
                                  </span>
                                  <span className="item-chain" title={`Version (hex): ${s.version}`}>
                                    Version: {hexToDecimal(s.version)}
                                  </span>
                                </span>
                              </div>
                              <div className="session-emoji" title="Verification emoji grid">
                                <EmojiGrid emojis={hashToEmoji(s.verificationHash)} />
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Empty state */}
                {pendingDiscoveries.length === 0 && sessions.length === 0 && (
                  <div className="empty-state">
                    <span className="empty-icon">🔗</span>
                    <span className="empty-text">No active sessions</span>
                    <span className="empty-hint">Visit a dApp to connect</span>
                  </div>
                )}
              </>
            )}

            {activeTab === "settings" && (
              <>
                {/* Trusted Apps */}
                {rememberedApps.length > 0 ? (
                  <div className="section trusted">
                    <h3 className="section-title">Trusted Apps</h3>
                    <p className="section-hint">Auto-approve connection requests</p>
                    <div className="item-list">
                      {rememberedApps.map((app) => {
                        const hostname = getHostname(app.origin);
                        const hasActiveSession = sessions.some(
                          (s) => s.appId === app.appId && s.origin === app.origin
                        );
                        return (
                          <div key={`${app.appId}-${app.origin}-${app.chainId}`} className="item trusted-app">
                            <div className="item-info">
                              <span className="item-name">
                                {app.appId}
                                {hasActiveSession && (
                                  <span className="active-indicator" title="Currently connected">●</span>
                                )}
                              </span>
                              <span className="item-origin">via {hostname}</span>
                              <span className="item-chain-info">
                                <span className="item-chain" title={`Chain ID (hex): ${app.chainId}`}>
                                  Chain: {hexToDecimal(app.chainId)}
                                </span>
                                <span className="item-chain" title={`Version (hex): ${app.version}`}>
                                  Version: {hexToDecimal(app.version)}
                                </span>
                              </span>
                            </div>
                            <button
                              className="btn btn-small btn-forget"
                              onClick={() => handleForgetApp(app.appId, app.origin)}
                              title="Remove from trusted apps"
                            >
                              Forget
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ) : (
                  <div className="empty-state">
                    <span className="empty-icon">🛡️</span>
                    <span className="empty-text">No trusted apps</span>
                    <span className="empty-hint">Apps are trusted after first connection</span>
                  </div>
                )}
              </>
            )}
          </>
        ) : (
          <div className="error-state">
            <span>Failed to load status</span>
          </div>
        )}
      </main>

      <footer className="popup-footer">
        <img
          src="/aztec_symbol_circle.png"
          alt="Aztec Network"
          className="aztec-logo"
        />
        <span className="aztec-text">Aztec Network</span>
        {status && <span className="version">v{status.walletVersion}</span>}
      </footer>
    </div>
  );
}

export default App;
