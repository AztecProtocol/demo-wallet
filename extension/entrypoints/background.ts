import {
  type EncryptedPayload,
  type ExportedPublicKey,
  type SecureKeyPair,
  generateKeyPair,
  exportPublicKey,
  importPublicKey,
  deriveSharedKey,
  encrypt,
  decrypt,
  hashSharedSecret,
} from "@aztec/wallet-sdk/crypto";
import type {
  DiscoveryRequest,
  DiscoveryResponse,
  WalletInfo,
  WalletMessage,
  WalletResponse,
} from "@aztec/wallet-sdk/types";

// Wallet configuration
const WALLET_ID = "aztec-keychain";
const WALLET_NAME = "Aztec Keychain";
const WALLET_VERSION = "1.0.0";
const NATIVE_HOST_NAME = "com.aztec.keychain";

/**
 * Active session with a connected dApp.
 * The shared key is derived via ECDH and never leaves the background script.
 * The verificationHash is the cryptographic proof for anti-MITM verification.
 */
interface ActiveSession {
  sharedKey: CryptoKey;
  requestId: string;
  tabId: number;
  origin: string;
  /** Hash of the shared secret - the canonical verification value */
  verificationHash: string;
  connectedAt: number;
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
 * Active sessions by request ID (from discovery).
 * Stores the derived shared key and session info for each connected dApp.
 */
const sessions = new Map<string, ActiveSession>();

/**
 * Tracks pending requests by messageId -> requestId.
 * Used to route native messaging responses back to the correct dApp.
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
  let nativePort: browser.runtime.Port | null = null;
  // Track whether the native host is connected to the Electron app backend
  // (not just whether the native port is open)
  let backendConnected = false;

  /**
   * Gets the current wallet status for the popup.
   */
  function getStatus() {
    return {
      // Only report connected when native host confirms backend connection
      connected: backendConnected,
      walletId: WALLET_ID,
      walletName: WALLET_NAME,
      walletVersion: WALLET_VERSION,
    };
  }

  /**
   * Broadcasts status update to any open popups.
   */
  function broadcastStatus() {
    browser.runtime
      .sendMessage({
        origin: "background",
        type: "status-update",
        status: getStatus(),
      })
      .catch(() => {
        // Popup might not be open, ignore errors
      });
  }

  // Generate key pair on startup
  await initializeKeyPair();

  // Clean up sessions when tabs are closed
  browser.tabs.onRemoved.addListener((tabId) => {
    for (const [requestId, session] of sessions) {
      if (session.tabId === tabId) {
        sessions.delete(requestId);
        console.log(`Session removed (tab closed): ${session.origin}`);
      }
    }
  });

  // Clean up sessions when tabs navigate away (refresh or navigate to different page)
  browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
    // 'loading' status indicates navigation started (refresh or new URL)
    if (changeInfo.status === "loading") {
      for (const [requestId, session] of sessions) {
        if (session.tabId === tabId) {
          sessions.delete(requestId);
          console.log(`Session removed (tab navigated): ${session.origin}`);
        }
      }
    }
  });

  // Handle messages from content script and popup
  browser.runtime.onMessage.addListener((event: any, sender, sendResponse) => {
    const { origin, type, content, requestId } = event;

    // Handle popup messages
    if (origin === "popup") {
      if (type === "get-status") {
        sendResponse(getStatus());
      } else if (type === "get-sessions") {
        // Return verificationHash - popup computes emoji lazily for display
        const sessionList = Array.from(sessions.values()).map((s) => ({
          requestId: s.requestId,
          origin: s.origin,
          verificationHash: s.verificationHash,
          connectedAt: s.connectedAt,
        }));
        console.log(`Popup requested sessions, returning ${sessionList.length} sessions`);
        sendResponse(sessionList);
      }
      return;
    }

    if (origin !== "content-script") {
      return;
    }

    const tabId = sender.tab?.id;
    const tabOrigin = sender.tab?.url
      ? new URL(sender.tab.url).origin
      : "unknown";
    if (!tabId) {
      return;
    }

    // Route based on message type (matches SDK types where applicable)
    switch (type) {
      case "aztec-wallet-discovery":
        // Use async IIFE for cleaner async/await handling
        (async () => {
          try {
            const result = await handleDiscovery(
              content as DiscoveryRequest,
              tabId,
              tabOrigin
            );
            sendResponse(result);
          } catch (err: any) {
            sendResponse({ success: false, error: err.message });
          }
        })();
        return true; // Keep channel open for async response

      case "secure-message":
        handleSecureMessage(requestId, content as EncryptedPayload);
        break;
    }
  });

  /**
   * Handles wallet discovery requests.
   * Now also establishes the secure channel by deriving the shared key from the dApp's public key.
   * Returns the wallet info so content script can send it with the MessagePort.
   */
  async function handleDiscovery(
    request: DiscoveryRequest,
    tabId: number,
    tabOrigin: string
  ): Promise<{ success: true; response: DiscoveryResponse }> {
    if (!walletKeyPair || !walletPublicKey) {
      await initializeKeyPair();
    }

    // Import the dApp's public key and derive shared secret
    const dAppPublicKey = await importPublicKey(request.publicKey);
    const sharedKey = await deriveSharedKey(
      walletKeyPair!.privateKey,
      dAppPublicKey
    );

    // Compute verification hash - this is the canonical anti-MITM proof
    // Emoji representation is computed lazily when displaying to the user
    const verificationHash = await hashSharedSecret(sharedKey);

    // Store the session
    sessions.set(request.requestId, {
      sharedKey,
      requestId: request.requestId,
      tabId,
      origin: tabOrigin,
      verificationHash,
      connectedAt: Date.now(),
    });
    console.log(`Session created: ${tabOrigin} (${request.requestId}), hash: ${verificationHash.slice(0, 8)}..., total sessions: ${sessions.size}`);

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

    // Return the response data - content script will send it with the MessagePort
    return { success: true, response };
  }

  /**
   * Handles encrypted messages from dApp.
   * Decrypts in background, processes, encrypts response.
   */
  async function handleSecureMessage(
    requestId: string,
    encrypted: EncryptedPayload
  ) {
    const session = sessions.get(requestId);
    if (!session) {
      console.error(`No session found for requestId ${requestId}`);
      return;
    }

    try {
      // Decrypt the message (only background script can do this)
      const message = await decrypt<WalletMessage>(
        session.sharedKey,
        encrypted
      );

      console.log("Received RPC call:", message.type);

      // Forward to native host
      if (nativePort) {
        // Track which requestId this request came from
        pendingRequests.set(message.messageId, requestId);
        nativePort.postMessage(message);
      } else {
        // Send error response if not connected
        await sendSecureResponse(requestId, {
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
   * Encrypts and sends response back to the dApp via content script.
   */
  async function sendSecureResponse(requestId: string, response: WalletResponse) {
    const session = sessions.get(requestId);
    if (!session) {
      console.error(`No session found for requestId ${requestId}`);
      return;
    }

    try {
      // Encrypt the response (only background script can do this)
      const encrypted = await encrypt(session.sharedKey, response);

      // Send encrypted response through content script
      browser.tabs.sendMessage(session.tabId, {
        origin: "background",
        type: "secure-response",
        requestId,
        content: encrypted,
      });
    } catch (err) {
      console.error("Failed to encrypt response:", err);
    }
  }

  /**
   * Connects to the wallet backend via Native Messaging.
   * The native host binary bridges to the Electron app via IPC socket.
   */
  function connect() {
    try {
      // Log extension ID for debugging native messaging configuration
      console.log(`Extension ID: ${browser.runtime.id}`);
      console.log(`Attempting to connect to native host: ${NATIVE_HOST_NAME}`);

      nativePort = browser.runtime.connectNative(NATIVE_HOST_NAME);

      nativePort.onMessage.addListener((response: any) => {
        // Handle status messages from native host
        if (response.type === "status") {
          backendConnected = response.status === "connected";
          console.log(`Backend connection status: ${backendConnected}`);
          broadcastStatus();
          return;
        }

        // Look up which requestId this response is for
        const requestId = pendingRequests.get(response.messageId);
        if (!requestId) {
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
        sendSecureResponse(requestId, response as WalletResponse);
      });

      nativePort.onDisconnect.addListener(() => {
        const error = browser.runtime.lastError;
        if (error) {
          console.error(
            `Native host disconnected with error: ${error.message}`
          );
          console.error(
            `Extension ID was: ${browser.runtime.id}. Ensure manifest 'allowed_origins' includes: chrome-extension://${browser.runtime.id}/`
          );
        } else {
          console.log("Native host disconnected");
        }
        nativePort = null;
        backendConnected = false;
        broadcastStatus();

        // Reconnect after a delay
        setTimeout(connect, 1000);
      });

      console.log("Connected to native messaging host");
      broadcastStatus();
    } catch (err) {
      console.error("Failed to connect to native host:", err);
      nativePort = null;
      // Retry connection
      setTimeout(connect, 1000);
    }
  }

  // Start connection to native host
  connect();
});
