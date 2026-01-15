import { useEffect, useState } from "react";
import { hashToEmoji } from "@aztec/wallet-sdk/crypto";
import "./App.css";

interface WalletStatus {
  connected: boolean;
  walletId: string;
  walletName: string;
  walletVersion: string;
}

type SessionStatus = "pending" | "approved" | "rejected";

interface ActiveSession {
  requestId: string;
  /** The canonical verification hash from the shared secret */
  verificationHash: string;
  origin: string;
  connectedAt: number;
  /** Application ID provided by the dApp */
  appId?: string;
  /** Session approval status */
  status: SessionStatus;
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
  const [sessions, setSessions] = useState<ActiveSession[]>([]);
  const [loading, setLoading] = useState(true);

  const refreshSessions = async () => {
    const sessionsResponse = await browser.runtime.sendMessage({
      origin: "popup",
      type: "get-sessions",
    });
    setSessions(sessionsResponse || []);
  };

  const handleApprove = async (requestId: string) => {
    const result = await browser.runtime.sendMessage({
      origin: "popup",
      type: "approve-session",
      requestId,
    });
    if (!result?.success && result?.error) {
      // Show error to user (backend not connected)
      alert(result.error);
    }
    await refreshSessions();
  };

  const handleReject = async (requestId: string) => {
    await browser.runtime.sendMessage({
      origin: "popup",
      type: "reject-session",
      requestId,
    });
    await refreshSessions();
  };

  const handleOpenApp = async () => {
    await browser.runtime.sendMessage({
      origin: "popup",
      type: "focus-app",
    });
  };

  useEffect(() => {
    // Get initial status and sessions
    Promise.all([
      browser.runtime.sendMessage({ origin: "popup", type: "get-status" }),
      browser.runtime.sendMessage({ origin: "popup", type: "get-sessions" }),
    ])
      .then(([statusResponse, sessionsResponse]) => {
        setStatus(statusResponse);
        setSessions(sessionsResponse || []);
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
        // Refresh sessions when status changes (e.g., backend disconnect clears sessions)
        refreshSessions();
      }
    };

    browser.runtime.onMessage.addListener(handleMessage);
    return () => browser.runtime.onMessage.removeListener(handleMessage);
  }, []);

  return (
    <div className="popup-container">
      <header className="popup-header">
        <div className="logo-container">
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
          <h1 className="title">Aztec Keychain</h1>
        </div>
        {status && <span className="version">v{status.walletVersion}</span>}
      </header>

      <main className="popup-main">
        {loading ? (
          <div className="status-card">
            <div className="loading-indicator">
              <div className="spinner" />
              <span>Loading...</span>
            </div>
          </div>
        ) : status ? (
          <>
            <div className="status-card">
              <div className="status-row">
                <span className="status-label">Backend Connection</span>
                <div className="status-value">
                  <span
                    className={`status-indicator ${
                      status.connected ? "connected" : "disconnected"
                    }`}
                  />
                  <span
                    className={
                      status.connected ? "text-connected" : "text-disconnected"
                    }
                  >
                    {status.connected ? "Connected" : "Disconnected"}
                  </span>
                </div>
              </div>
              {status.connected && (
                <div className="status-actions">
                  <button className="btn btn-secondary" onClick={handleOpenApp}>
                    Open App
                  </button>
                </div>
              )}
            </div>

            {/* Pending Sessions - Connection Requests */}
            {sessions.filter((s) => s.status === "pending").length > 0 && (
              <div className="session-section pending">
                <h3 className="section-title">Connection Requests</h3>
                <div className="session-list">
                  {sessions
                    .filter((s) => s.status === "pending")
                    .map((s) => {
                      const hostname = getHostname(s.origin);
                      const mismatch = !domainsMatch(s.origin, s.appId);
                      return (
                        <div key={s.requestId} className="session-item pending">
                          <div className="session-info">
                            <span className="session-app">
                              {s.appId || hostname}
                            </span>
                            {s.appId && s.appId !== hostname && (
                              <span className="session-origin">
                                via {hostname}
                              </span>
                            )}
                            {mismatch && (
                              <span
                                className="session-warning"
                                title={`App ID "${s.appId}" doesn't match domain "${hostname}"`}
                              >
                                ⚠️
                              </span>
                            )}
                          </div>
                          <div className="session-verification">
                            <span className="verification-label">
                              Verify emoji:
                            </span>
                            <span className="session-emoji large">
                              {hashToEmoji(s.verificationHash)}
                            </span>
                          </div>
                          <div className="session-actions">
                            <button
                              className={`btn btn-approve ${
                                !status.connected ? "disabled" : ""
                              }`}
                              onClick={() => handleApprove(s.requestId)}
                              disabled={!status.connected}
                              title={
                                !status.connected
                                  ? "Open the wallet app first"
                                  : ""
                              }
                            >
                              Allow
                            </button>
                            <button
                              className="btn btn-reject"
                              onClick={() => handleReject(s.requestId)}
                            >
                              Deny
                            </button>
                          </div>
                          {!status.connected && (
                            <div className="session-warning-banner">
                              Open the wallet app to approve this connection
                            </div>
                          )}
                        </div>
                      );
                    })}
                </div>
              </div>
            )}

            {/* Approved Sessions */}
            {sessions.filter((s) => s.status === "approved").length > 0 && (
              <div className="session-section">
                <h3 className="section-title">Connected Apps</h3>
                <div className="session-list">
                  {sessions
                    .filter((s) => s.status === "approved")
                    .map((s) => {
                      const hostname = getHostname(s.origin);
                      const mismatch = !domainsMatch(s.origin, s.appId);
                      return (
                        <div key={s.requestId} className="session-item">
                          <div className="session-info">
                            <span className="session-app">
                              {s.appId || hostname}
                            </span>
                            {s.appId && s.appId !== hostname && (
                              <span className="session-origin">
                                via {hostname}
                              </span>
                            )}
                            {mismatch && (
                              <span
                                className="session-warning"
                                title={`App ID "${s.appId}" doesn't match domain "${hostname}"`}
                              >
                                ⚠️
                              </span>
                            )}
                          </div>
                          <span className="session-emoji">
                            {hashToEmoji(s.verificationHash)}
                          </span>
                        </div>
                      );
                    })}
                </div>
              </div>
            )}
          </>
        ) : (
          <div className="status-card error">
            <span>Failed to load status</span>
          </div>
        )}
      </main>

      <footer className="popup-footer">
        <span>Built on</span>
        <img
          src="/aztec_symbol_circle.png"
          alt="Aztec Network"
          className="aztec-logo"
        />
        <span className="aztec-text">Aztec Network</span>
      </footer>
    </div>
  );
}

export default App;
