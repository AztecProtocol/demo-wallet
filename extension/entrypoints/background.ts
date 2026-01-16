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
import {
  WalletMessageType,
  type DiscoveryRequest,
  type DiscoveryResponse,
  type WalletInfo,
  type WalletMessage,
  type WalletResponse,
} from "@aztec/wallet-sdk/types";

// Wallet configuration
const WALLET_ID = "aztec-keychain";
const WALLET_NAME = "Aztec Keychain";
const WALLET_VERSION = "1.0.0";
const NATIVE_HOST_NAME = "com.aztec.keychain";

/**
 * Session status for connection approval flow
 */
type SessionStatus = "pending" | "approved" | "rejected";

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
  verificationHash: string;
  connectedAt: number;
  appId?: string;
  /** Session approval status - defaults to "approved" for backward compatibility */
  status: SessionStatus;
}

/**
 * Pending message awaiting session approval
 */
interface PendingApprovalMessage {
  requestId: string;
  encrypted: EncryptedPayload;
  messageId: string;
}

/**
 * Chunk metadata for reassembling large messages from native host.
 * Messages exceeding 1MB are automatically chunked by the native host.
 */
interface ChunkedMessage {
  __chunked: true;
  chunkId: string;
  chunkIndex: number;
  totalChunks: number;
  data: string;
}

/**
 * Tracks partial chunks being reassembled.
 */
interface PendingChunks {
  chunks: (string | undefined)[];
  receivedCount: number;
  totalChunks: number;
  createdAt: number;
}

/**
 * Storage for chunks being reassembled, keyed by chunkId.
 */
const pendingChunks = new Map<string, PendingChunks>();

// Clean up stale chunks after 30 seconds
const CHUNK_TIMEOUT_MS = 30000;

/**
 * Check if a message is a chunk that needs reassembly.
 */
function isChunkedMessage(message: unknown): message is ChunkedMessage {
  return (
    typeof message === "object" &&
    message !== null &&
    "__chunked" in message &&
    (message as ChunkedMessage).__chunked === true
  );
}

/**
 * Process a chunk and return the reassembled message if complete.
 * Returns null if more chunks are needed.
 */
function processChunk(chunk: ChunkedMessage): unknown | null {
  const { chunkId, chunkIndex, totalChunks, data } = chunk;

  // Get or create pending chunks entry
  let pending = pendingChunks.get(chunkId);
  if (!pending) {
    pending = {
      chunks: new Array(totalChunks),
      receivedCount: 0,
      totalChunks,
      createdAt: Date.now(),
    };
    pendingChunks.set(chunkId, pending);
  }

  // Store the chunk data
  if (pending.chunks[chunkIndex] === undefined) {
    pending.chunks[chunkIndex] = data;
    pending.receivedCount++;
  }

  console.log(
    `Received chunk ${chunkIndex + 1}/${totalChunks} for ${chunkId} (${pending.receivedCount}/${totalChunks} received)`
  );

  // Check if all chunks received
  if (pending.receivedCount === totalChunks) {
    // Reassemble the message
    const fullJson = pending.chunks.join("");
    pendingChunks.delete(chunkId);

    console.log(`Reassembled chunked message: ${fullJson.length} bytes`);

    try {
      return JSON.parse(fullJson);
    } catch (err) {
      console.error("Failed to parse reassembled message:", err);
      return null;
    }
  }

  return null;
}

/**
 * Clean up stale pending chunks.
 */
function cleanupStaleChunks(): void {
  const now = Date.now();
  for (const [chunkId, pending] of pendingChunks) {
    if (now - pending.createdAt > CHUNK_TIMEOUT_MS) {
      console.warn(
        `Cleaning up stale chunks for ${chunkId} (${pending.receivedCount}/${pending.totalChunks} received)`
      );
      pendingChunks.delete(chunkId);
    }
  }
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
 * Messages waiting for session approval.
 * When a session is pending and a message arrives, we queue it here.
 */
const pendingApprovalMessages: PendingApprovalMessage[] = [];

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

  /**
   * Handles messages from the popup UI.
   * Returns true if the response will be sent asynchronously.
   */
  function handlePopupMessage(
    type: string,
    event: any,
    sendResponse: (response: any) => void
  ): boolean {
    switch (type) {
      case "get-status":
        sendResponse(getStatus());
        return false;

      case "focus-app":
        if (nativePort && backendConnected) {
          nativePort.postMessage({ type: "focus-app" });
          sendResponse({ success: true });
        } else {
          sendResponse({ success: false, error: "Backend not connected" });
        }
        return false;

      case "get-sessions": {
        const sessionList = Array.from(sessions.values()).map((s) => ({
          requestId: s.requestId,
          origin: s.origin,
          verificationHash: s.verificationHash,
          connectedAt: s.connectedAt,
          appId: s.appId,
          status: s.status,
        }));
        console.log(
          `Popup requested sessions, returning ${sessionList.length} sessions`
        );
        sendResponse(sessionList);
        return false;
      }

      case "approve-session":
        (async () => {
          if (!backendConnected) {
            sendResponse({
              success: false,
              error: "Wallet app is not running. Please open the app first.",
            });
            return;
          }

          const session = sessions.get(event.requestId);
          if (session && session.status === "pending") {
            session.status = "approved";
            console.log(`Session ${event.requestId} approved by user`);

            // Process any queued messages for this session
            const queuedMessages = pendingApprovalMessages.filter(
              (m) => m.requestId === event.requestId
            );
            // Remove from queue
            for (let i = pendingApprovalMessages.length - 1; i >= 0; i--) {
              if (pendingApprovalMessages[i].requestId === event.requestId) {
                pendingApprovalMessages.splice(i, 1);
              }
            }
            // Process each queued message
            for (const queuedMsg of queuedMessages) {
              try {
                const message = await decrypt<WalletMessage>(
                  session.sharedKey,
                  queuedMsg.encrypted
                );
                await processApprovedMessage(session, message);
              } catch (err) {
                console.error("Failed to process queued message:", err);
              }
            }
            sendResponse({ success: true });
          } else {
            sendResponse({
              success: false,
              error: "Session not found or not pending",
            });
          }
        })();
        return true; // Keep channel open for async response

      case "reject-session": {
        const session = sessions.get(event.requestId);
        if (session && session.status === "pending") {
          session.status = "rejected";
          console.log(`Session ${event.requestId} rejected by user`);

          // Send error response for any queued messages
          const queuedMessages = pendingApprovalMessages.filter(
            (m) => m.requestId === event.requestId
          );
          // Remove from queue
          for (let i = pendingApprovalMessages.length - 1; i >= 0; i--) {
            if (pendingApprovalMessages[i].requestId === event.requestId) {
              pendingApprovalMessages.splice(i, 1);
            }
          }
          // Send rejection errors
          for (const queuedMsg of queuedMessages) {
            sendSecureResponse(event.requestId, {
              messageId: queuedMsg.messageId,
              walletId: WALLET_ID,
              error: { message: "Connection rejected by user" },
            });
          }
          sendResponse({ success: true });
        } else {
          sendResponse({
            success: false,
            error: "Session not found or not pending",
          });
        }
        return false;
      }

      default:
        return false;
    }
  }

  // Handle messages from content script and popup
  browser.runtime.onMessage.addListener((event: any, sender, sendResponse) => {
    const { origin, type, content, requestId } = event;

    // Handle popup messages
    if (origin === "popup") {
      return handlePopupMessage(type, event, sendResponse);
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
      case WalletMessageType.DISCOVERY:
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

    // Store the session - starts as "pending" until user approves
    sessions.set(request.requestId, {
      sharedKey,
      requestId: request.requestId,
      tabId,
      origin: tabOrigin,
      verificationHash,
      connectedAt: Date.now(),
      status: "pending",
    });
    console.log(
      `Session created (pending approval): ${tabOrigin} (${
        request.requestId
      }), hash: ${verificationHash.slice(0, 8)}..., total sessions: ${
        sessions.size
      }`
    );

    const walletInfo: WalletInfo = {
      id: WALLET_ID,
      name: WALLET_NAME,
      version: WALLET_VERSION,
      publicKey: walletPublicKey!,
    };

    const response: DiscoveryResponse = {
      type: WalletMessageType.DISCOVERY_RESPONSE,
      requestId: request.requestId,
      walletInfo,
    };

    // Return the response data - content script will send it with the MessagePort
    return { success: true, response };
  }

  async function openApprovalPopup(requestId: string) {
    // browser.action.openPopup() is only available in Manifest V3 and may not work in Firefox
    // It also requires a user gesture in most browsers, so we fall back gracefully
    try {
      if (browser.action?.openPopup) {
        await browser.action.openPopup();
      } else if ((browser as any).browserAction?.openPopup) {
        // Firefox MV2 fallback
        await (browser as any).browserAction.openPopup();
      }
    } catch (err) {
      // openPopup() fails if not triggered by user gesture - this is expected
      console.log("Could not open popup programmatically (expected in most cases):", err);
    }
  }

  /**
   * Processes a message after session is approved
   */
  async function processApprovedMessage(
    session: ActiveSession,
    message: WalletMessage
  ) {
    console.log("Processing approved RPC call:", message.type);

    // Forward to native host
    if (nativePort) {
      pendingRequests.set(message.messageId, session.requestId);
      nativePort.postMessage(message);
    } else {
      await sendSecureResponse(session.requestId, {
        messageId: message.messageId,
        walletId: WALLET_ID,
        error: { message: "Wallet backend not connected" },
      });
    }
  }

  /**
   * Handles encrypted messages from dApp.
   * Decrypts in background, processes, encrypts response.
   * If session is pending, queues the message and opens approval popup.
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

      if (!session.appId && message.appId) {
        session.appId = message.appId;
        console.log(`Session ${requestId} appId set to: ${message.appId}`);
      }

      console.log(
        "Received RPC call:",
        message.type,
        "session status:",
        session.status
      );

      // Handle disconnect request from dApp
      if (message.type === WalletMessageType.DISCONNECT) {
        console.log(`Session ${requestId} disconnected by dApp`);
        sessions.delete(requestId);
        for (let i = pendingApprovalMessages.length - 1; i >= 0; i--) {
          if (pendingApprovalMessages[i].requestId === requestId) {
            pendingApprovalMessages.splice(i, 1);
          }
        }
        for (const [messageId, reqId] of pendingRequests.entries()) {
          if (reqId === requestId) {
            pendingRequests.delete(messageId);
          }
        }
        return;
      }

      // Check session status
      if (session.status === "rejected") {
        await sendSecureResponse(requestId, {
          messageId: message.messageId,
          walletId: WALLET_ID,
          error: { message: "Connection rejected by user" },
        });
        return;
      }

      if (session.status === "pending") {
        pendingApprovalMessages.push({
          requestId,
          encrypted,
          messageId: message.messageId,
        });
        console.log(
          `Message queued for approval, opening popup for session ${requestId}`
        );
        await openApprovalPopup(requestId);
        return;
      }

      await processApprovedMessage(session, message);
    } catch (err) {
      console.error("Failed to decrypt message:", err);
    }
  }

  /**
   * Encrypts and sends response back to the dApp via content script.
   */
  async function sendSecureResponse(
    requestId: string,
    response: WalletResponse
  ) {
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

      nativePort.onMessage.addListener((rawResponse: any) => {
        // Handle chunked messages (for responses > 1MB)
        let response = rawResponse;
        if (isChunkedMessage(rawResponse)) {
          const reassembled = processChunk(rawResponse);
          if (reassembled === null) {
            // Still waiting for more chunks
            return;
          }
          response = reassembled;
        }

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

        // Prune all active sessions when backend disconnects
        // Sessions are tied to the shared key which is only valid for this connection
        const sessionCount = sessions.size;
        if (sessionCount > 0) {
          console.log(
            `Pruning ${sessionCount} sessions due to backend disconnect`
          );

          // Send encrypted disconnect notification to each session
          // Using the secure channel ensures uniform message handling in SDK
          for (const session of sessions.values()) {
            sendSecureResponse(session.requestId, {
              messageId: "disconnect",
              walletId: WALLET_ID,
              error: {
                type: WalletMessageType.SESSION_DISCONNECTED,
                message: "Wallet backend disconnected",
              },
            }).catch(() => {
              // Tab might be closed, ignore errors
            });
          }

          sessions.clear();
          pendingApprovalMessages.length = 0;
          pendingRequests.clear();
        }

        broadcastStatus();

        // Reconnect after a delay
        setTimeout(connect, 1000);
      });

      console.log("Connected to native messaging host");
      broadcastStatus();

      // Periodically clean up stale chunks
      setInterval(cleanupStaleChunks, 10000);
    } catch (err) {
      console.error("Failed to connect to native host:", err);
      nativePort = null;
      setTimeout(connect, 1000);
    }
  }

  connect();
});
