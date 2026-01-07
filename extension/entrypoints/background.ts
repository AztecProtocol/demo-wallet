import type { ExportedPublicKey } from "@aztec/wallet-sdk/providers/extension/crypto";
import type {
  DiscoveryRequest,
  DiscoveryResponse,
  WalletInfo,
  WalletMessage,
  WalletResponse,
} from "@aztec/wallet-sdk/providers/types";

// Wallet configuration
const WALLET_ID = "demo-aztec-wallet";
const WALLET_NAME = "Demo Aztec Wallet";
const WALLET_VERSION = "1.0.0";

// Store wallet's ECDH key pair (in a real wallet, this would be managed more securely)
let walletKeyPair: {
  publicKey: JsonWebKey;
  privateKey: JsonWebKey;
} | null = null;

/**
 * Generates an ECDH key pair for the wallet
 */
async function generateWalletKeyPair() {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: "ECDH",
      namedCurve: "P-256",
    },
    true, // extractable
    ["deriveKey"]
  );

  walletKeyPair = {
    publicKey: await crypto.subtle.exportKey("jwk", keyPair.publicKey),
    privateKey: await crypto.subtle.exportKey("jwk", keyPair.privateKey),
  };

  return walletKeyPair;
}

/**
 * Gets the wallet's public key in the format expected by the SDK
 */
function getExportedPublicKey(): ExportedPublicKey | null {
  if (!walletKeyPair) return null;
  return {
    kty: walletKeyPair.publicKey.kty!,
    crv: walletKeyPair.publicKey.crv!,
    x: walletKeyPair.publicKey.x!,
    y: walletKeyPair.publicKey.y!,
  };
}

export default defineBackground(() => {
  let webSocket: WebSocket | null = null;

  // Generate key pair on startup
  generateWalletKeyPair().then(() => {
    console.log("Wallet ECDH key pair generated");
  });

  // Handle messages from content script
  browser.runtime.onMessage.addListener((event: any, sender, sendResponse) => {
    const { origin, type, content, walletId } = event;

    if (origin !== "injected") {
      return;
    }

    // Handle discovery requests
    if (type === "discovery") {
      handleDiscovery(content as DiscoveryRequest);
      return;
    }

    // Handle request for wallet's key pair (for secure channel establishment)
    if (type === "get-keypair") {
      // Return the key pair for the content script to derive shared secret
      sendResponse(walletKeyPair);
      return true; // Keep channel open for async response
    }

    // Handle RPC requests (forwarded from secure channel)
    if (type === "rpc-request") {
      handleRpcRequest(walletId, content as WalletMessage);
      return;
    }
  });

  /**
   * Handles wallet discovery requests
   */
  async function handleDiscovery(request: DiscoveryRequest) {
    // Ensure we have a key pair
    if (!walletKeyPair) {
      await generateWalletKeyPair();
    }

    const publicKey = getExportedPublicKey();
    if (!publicKey) {
      console.error("Failed to get public key for discovery response");
      return;
    }

    const walletInfo: WalletInfo = {
      id: WALLET_ID,
      name: WALLET_NAME,
      version: WALLET_VERSION,
      publicKey,
    };

    const response: DiscoveryResponse = {
      type: "aztec-wallet-discovery-response",
      requestId: request.requestId,
      walletInfo,
    };

    // Send discovery response back through content script
    const [tab] = await browser.tabs.query({
      active: true,
      currentWindow: true,
    });

    if (tab?.id) {
      browser.tabs.sendMessage(tab.id, {
        origin: "background",
        type: "discovery-response",
        content: response,
      });
    }
  }

  /**
   * Handles RPC requests from the dApp (via secure channel)
   */
  function handleRpcRequest(walletId: string, message: WalletMessage) {
    console.log("Processing RPC request:", message.type);

    // Forward to WebSocket backend if connected
    if (webSocket && webSocket.readyState === WebSocket.OPEN) {
      webSocket.send(JSON.stringify(message));
    } else {
      // Send error response if not connected
      sendRpcResponse({
        messageId: message.messageId,
        walletId,
        error: { message: "Wallet backend not connected" },
      });
    }
  }

  /**
   * Sends an RPC response back through the content script
   */
  async function sendRpcResponse(response: WalletResponse) {
    const [tab] = await browser.tabs.query({
      active: true,
      currentWindow: true,
    });

    if (tab?.id) {
      browser.tabs.sendMessage(tab.id, {
        origin: "background",
        type: "rpc-response",
        content: response,
      });
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
        keepAlive();
        resolve(true);
      };

      webSocket.onmessage = async (event) => {
        console.log("Received from backend:", event.data);

        try {
          const response = JSON.parse(event.data) as WalletResponse;
          // Ensure walletId is set
          if (!response.walletId) {
            response.walletId = WALLET_ID;
          }
          await sendRpcResponse(response);
        } catch (err) {
          console.error("Failed to parse backend response:", err);
        }
      };

      webSocket.onclose = (event) => {
        console.log("WebSocket connection closed, reconnecting...");
        webSocket = null;
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
