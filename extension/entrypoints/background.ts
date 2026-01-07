import {
  type ExportedPublicKey,
  type SecureKeyPair,
  generateKeyPair,
  exportPublicKey,
  importPublicKey,
  deriveSharedKey,
  encrypt,
  decrypt,
} from "@aztec/wallet-sdk/crypto";
import type {
  ConnectRequest,
  DiscoveryRequest,
  DiscoveryResponse,
  SecureMessage,
  SecureResponse,
  WalletInfo,
  WalletMessage,
  WalletResponse,
} from "@aztec/wallet-sdk/types";

// Wallet configuration
const WALLET_ID = "demo-aztec-wallet";
const WALLET_NAME = "Demo Aztec Wallet";
const WALLET_VERSION = "1.0.0";

/**
 * Secure connection state for a connected dApp.
 * The shared key is derived via ECDH and never leaves the background script.
 */
interface SecureConnection {
  sharedKey: CryptoKey;
  appId: string;
  tabId: number;
}

/**
 * Wallet's ECDH key pair for secure channel establishment.
 * The private key never leaves the background script.
 */
let walletKeyPair: SecureKeyPair | null = null;

/**
 * Exported public key for discovery responses.
 */
let walletPublicKey: ExportedPublicKey | null = null;

/**
 * Active secure connections by app ID.
 * Stores the derived shared key for each connected dApp.
 */
const connections = new Map<string, SecureConnection>();

/**
 * Tracks pending requests by messageId -> appId.
 * Used to route WebSocket responses back to the correct dApp.
 */
const pendingRequests = new Map<string, string>();

/**
 * Generates a new ECDH key pair for the wallet.
 * The private key remains in this script; only the public key is exported.
 */
async function initializeKeyPair(): Promise<void> {
  walletKeyPair = await generateKeyPair();
  walletPublicKey = await exportPublicKey(walletKeyPair.publicKey);
}

export default defineBackground(async () => {
  let webSocket: WebSocket | null = null;

  /**
   * Gets the current wallet status for the popup.
   */
  function getStatus() {
    return {
      wsConnected: webSocket?.readyState === WebSocket.OPEN,
      connectedApps: connections.size,
      walletId: WALLET_ID,
      walletName: WALLET_NAME,
      walletVersion: WALLET_VERSION,
    };
  }

  /**
   * Broadcasts status update to any open popups.
   */
  function broadcastStatus() {
    browser.runtime.sendMessage({
      origin: "background",
      type: "status-update",
      status: getStatus(),
    }).catch(() => {
      // Popup might not be open, ignore errors
    });
  }

  // Generate key pair on startup
  await initializeKeyPair();

  // Handle messages from content script and popup
  browser.runtime.onMessage.addListener(
    (event: any, sender, sendResponse) => {
      const { origin, type, content, appId } = event;

      // Handle popup requests
      if (origin === "popup") {
        if (type === "get-status") {
          sendResponse(getStatus());
          return true;
        }
        return;
      }

      if (origin !== "content-script") {
        return;
      }

      const tabId = sender.tab?.id;
      if (!tabId) {
        console.error("Message received without tab ID");
        return;
      }

      // Route based on message type (matches SDK types where applicable)
      switch (type) {
        case "aztec-wallet-discovery":
          handleDiscovery(content as DiscoveryRequest, tabId);
          break;

        case "aztec-wallet-connect":
          // Use async IIFE for cleaner async/await handling
          (async () => {
            try {
              await establishSecureChannel(content as ConnectRequest, tabId);
              sendResponse({ success: true });
            } catch (err: any) {
              console.error("Failed to establish secure channel:", err);
              sendResponse({ success: false, error: err.message });
            }
          })();
          return true; // Keep channel open for async response

        case "secure-message":
          handleSecureMessage(appId, content as SecureMessage);
          break;
      }
    }
  );

  /**
   * Handles wallet discovery requests.
   * Discovery is public/unencrypted - wallet announces itself to the page.
   */
  async function handleDiscovery(request: DiscoveryRequest, tabId: number) {
    if (!walletPublicKey) {
      await initializeKeyPair();
    }

    const walletInfo: WalletInfo = {
      id: WALLET_ID,
      name: WALLET_NAME,
      version: WALLET_VERSION,
      publicKey: walletPublicKey!,
    };

    const response: DiscoveryResponse = {
      type: "aztec-wallet-discovery-response",
      requestId: request.requestId,
      walletInfo,
    };

    browser.tabs.sendMessage(tabId, {
      origin: "background",
      type: "aztec-wallet-discovery-response",
      content: response,
    });
  }

  /**
   * Establishes a secure channel with a dApp.
   * Derives shared key using ECDH - private key and shared key never leave this script.
   *
   * This mirrors the SDK's ExtensionWallet.establishSecureChannel() but on the wallet side.
   */
  async function establishSecureChannel(
    request: ConnectRequest,
    tabId: number
  ): Promise<void> {
    if (!walletKeyPair) {
      throw new Error("Wallet key pair not initialized");
    }

    // Import the dApp's public key
    const dAppPublicKey = await importPublicKey(request.publicKey);

    // Derive shared secret (this stays in background script)
    const sharedKey = await deriveSharedKey(
      walletKeyPair.privateKey,
      dAppPublicKey
    );

    // Store the connection by appId
    connections.set(request.appId, {
      sharedKey,
      appId: request.appId,
      tabId,
    });

    console.log(`Secure channel established with app ${request.appId}`);
  }

  /**
   * Handles encrypted messages from dApp (SecureMessage).
   * Decrypts in background, processes, encrypts response.
   */
  async function handleSecureMessage(
    appId: string,
    secureMessage: SecureMessage
  ) {
    const connection = connections.get(appId);
    if (!connection) {
      console.error(`No connection found for app ${appId}`);
      return;
    }

    try {
      // Decrypt the message (only background script can do this)
      const message = await decrypt<WalletMessage>(
        connection.sharedKey,
        secureMessage.encrypted
      );

      console.log("Received RPC call:", message.type);

      // Forward to WebSocket backend
      if (webSocket && webSocket.readyState === WebSocket.OPEN) {
        // Track which appId this request came from
        pendingRequests.set(message.messageId, appId);
        webSocket.send(JSON.stringify(message));
      } else {
        // Send error response if not connected
        await sendSecureResponse(appId, {
          messageId: message.messageId,
          walletId: WALLET_ID,
          error: { message: "Wallet backend not connected" },
        });
      }
    } catch (err) {
      console.error("Failed to decrypt message:", err);
    }
  }

  /**
   * Encrypts and sends a SecureResponse back to the dApp via content script.
   */
  async function sendSecureResponse(appId: string, response: WalletResponse) {
    const connection = connections.get(appId);
    if (!connection) {
      console.error(`No connection found for app ${appId}`);
      return;
    }

    try {
      // Encrypt the response (only background script can do this)
      const encrypted = await encrypt(connection.sharedKey, response);
      const secureResponse: SecureResponse = { encrypted };

      // Send encrypted response through content script
      browser.tabs.sendMessage(connection.tabId, {
        origin: "background",
        type: "secure-response",
        appId,
        content: secureResponse,
      });
    } catch (err) {
      console.error("Failed to encrypt response:", err);
    }
  }

  /**
   * Connects to the wallet backend via WebSocket
   */
  function connect() {
    return new Promise((resolve, reject) => {
      webSocket = new WebSocket("ws://localhost:8765");

      webSocket.onopen = () => {
        console.log("WebSocket connected to wallet backend");
        broadcastStatus();
        keepAlive();
        resolve(true);
      };

      webSocket.onmessage = async (event) => {
        console.log("Received from backend:", event.data);

        try {
          const response = JSON.parse(event.data) as WalletResponse;

          // Look up which appId this response is for
          const appId = pendingRequests.get(response.messageId);
          if (!appId) {
            console.error(
              `No pending request found for messageId ${response.messageId}`
            );
            return;
          }
          pendingRequests.delete(response.messageId);

          // Ensure walletId is set
          if (!response.walletId) {
            response.walletId = WALLET_ID;
          }

          // Encrypt and send response to the correct dApp
          await sendSecureResponse(appId, response);
        } catch (err) {
          console.error("Failed to parse backend response:", err);
        }
      };

      webSocket.onclose = (event) => {
        console.log("WebSocket connection closed, reconnecting...");
        webSocket = null;
        broadcastStatus();
        setTimeout(connect, 1000);
      };

      webSocket.onerror = (err) => {
        console.error("WebSocket error:", err);
      };
    });
  }

  /**
   * Keeps the service worker alive
   */
  function keepAlive() {
    const keepAliveIntervalId = setInterval(
      () => {
        if (webSocket && webSocket.readyState === WebSocket.OPEN) {
          webSocket.send("keepalive");
        } else {
          clearInterval(keepAliveIntervalId);
        }
      },
      20 * 1000 // 20 seconds
    );
  }

  // Start connection
  connect();
});
