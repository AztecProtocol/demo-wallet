import { useEffect, useState } from "react";
import "./App.css";

interface WalletStatus {
  wsConnected: boolean;
  connectedApps: number;
  walletId: string;
  walletName: string;
  walletVersion: string;
}

function App() {
  const [status, setStatus] = useState<WalletStatus | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Get initial status
    browser.runtime
      .sendMessage({ origin: "popup", type: "get-status" })
      .then((response) => {
        setStatus(response);
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
          <h1 className="title">Keychain</h1>
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
                    className={`status-indicator ${status.wsConnected ? "connected" : "disconnected"}`}
                  />
                  <span
                    className={
                      status.wsConnected ? "text-connected" : "text-disconnected"
                    }
                  >
                    {status.wsConnected ? "Connected" : "Disconnected"}
                  </span>
                </div>
              </div>
            </div>

            <div className="status-card">
              <div className="status-row">
                <span className="status-label">Connected dApps</span>
                <span className="status-count">{status.connectedApps}</span>
              </div>
            </div>

            {!status.wsConnected && (
              <div className="warning-card">
                <svg
                  className="warning-icon"
                  viewBox="0 0 24 24"
                  fill="none"
                  xmlns="http://www.w3.org/2000/svg"
                >
                  <path
                    d="M12 9V13M12 17H12.01M21 12C21 16.9706 16.9706 21 12 21C7.02944 21 3 16.9706 3 12C3 7.02944 7.02944 3 12 3C16.9706 3 21 7.02944 21 12Z"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                <div className="warning-content">
                  <span className="warning-title">Wallet backend offline</span>
                  <span className="warning-text">
                    Start the demo-wallet app to enable transactions
                  </span>
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
