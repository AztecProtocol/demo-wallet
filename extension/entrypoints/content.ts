import {
  decrypt,
  deriveSharedKey,
  encrypt,
  importPublicKey,
} from "@aztec/wallet-sdk/crypto";
import type {
  ConnectRequest,
  SecureMessage,
  SecureResponse,
  WalletMessage,
  WalletResponse,
} from "@aztec/wallet-sdk/types";

/**
 * Manages a secure channel connection with a dApp
 */
interface SecureConnection {
  port: MessagePort;
  sharedKey: CryptoKey;
  appId: string;
}

export default defineContentScript({
  matches: ["*://*/*"],
  main() {
    // Map of walletId -> secure connection
    const connections = new Map<string, SecureConnection>();

    // Listen for messages from the web page (discovery and connect requests only)
    window.addEventListener("message", async (event) => {
      // Only accept messages from the same window
      if (event.source !== window) {
        return;
      }

      const data = event.data;

      // Handle discovery requests (public, unencrypted)
      if (data?.type === "aztec-wallet-discovery") {
        // Forward discovery to background script
        browser.runtime.sendMessage({
          origin: "injected",
          type: "discovery",
          content: data,
        });
        return;
      }

      // Handle connection requests (establishes secure channel)
      if (data?.type === "aztec-wallet-connect") {
        await handleConnectRequest(data as ConnectRequest, event.ports[0]);
        return;
      }
    });

    // Listen for messages from the background script
    browser.runtime.onMessage.addListener((event: any) => {
      const { content, origin, type } = event;
      if (origin !== "background") {
        return;
      }

      // Handle discovery responses (public, unencrypted - sent via postMessage)
      if (type === "discovery-response") {
        window.postMessage(content);
        return;
      }

      // Handle RPC responses (need to encrypt and send over secure channel)
      if (type === "rpc-response") {
        handleRpcResponse(content as WalletResponse);
        return;
      }
    });

    /**
     * Handles a connection request from a dApp
     * Establishes a secure MessageChannel with ECDH key derivation
     */
    async function handleConnectRequest(
      request: ConnectRequest,
      port: MessagePort
    ) {
      if (!port) {
        console.error("No MessagePort received in connect request");
        return;
      }

      try {
        // Get wallet's key pair from background script
        const walletKeyPair = await browser.runtime.sendMessage({
          origin: "injected",
          type: "get-keypair",
          walletId: request.walletId,
        });

        if (!walletKeyPair) {
          console.error("Failed to get wallet key pair");
          return;
        }

        // Import the dApp's public key
        const dAppPublicKey = await importPublicKey(request.publicKey);

        // Import wallet's private key for key derivation
        const walletPrivateKey = await crypto.subtle.importKey(
          "jwk",
          walletKeyPair.privateKey,
          { name: "ECDH", namedCurve: "P-256" },
          false,
          ["deriveKey"]
        );

        // Derive shared secret
        const sharedKey = await deriveSharedKey(walletPrivateKey, dAppPublicKey);

        // Store the connection
        connections.set(request.walletId, {
          port,
          sharedKey,
          appId: request.appId,
        });

        // Set up message handler for the secure channel
        port.onmessage = async (event: MessageEvent<SecureMessage>) => {
          await handleSecureMessage(request.walletId, event.data);
        };

        // Start receiving messages
        port.start();

        console.log(
          `Secure channel established for wallet ${request.walletId} with app ${request.appId}`
        );
      } catch (err) {
        console.error("Failed to establish secure channel:", err);
      }
    }

    /**
     * Handles an encrypted message from the dApp
     */
    async function handleSecureMessage(
      walletId: string,
      secureMessage: SecureMessage
    ) {
      const connection = connections.get(walletId);
      if (!connection) {
        console.error(`No connection found for wallet ${walletId}`);
        return;
      }

      try {
        // Decrypt the message
        const message = await decrypt<WalletMessage>(
          connection.sharedKey,
          secureMessage.encrypted
        );

        console.log("Received encrypted RPC call:", message.type);

        // Forward to background script for processing
        browser.runtime.sendMessage({
          origin: "injected",
          type: "rpc-request",
          walletId,
          content: message,
        });
      } catch (err) {
        console.error("Failed to decrypt message:", err);
      }
    }

    /**
     * Handles an RPC response from the background script
     * Encrypts and sends over the secure channel
     */
    async function handleRpcResponse(response: WalletResponse) {
      const connection = connections.get(response.walletId);
      if (!connection) {
        console.error(`No connection found for wallet ${response.walletId}`);
        return;
      }

      try {
        // Encrypt the response
        const encrypted = await encrypt(connection.sharedKey, response);
        const secureResponse: SecureResponse = { encrypted };

        // Send over the secure MessageChannel
        connection.port.postMessage(secureResponse);
      } catch (err) {
        console.error("Failed to encrypt response:", err);
      }
    }
  },
});
