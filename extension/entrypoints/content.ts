import type { EncryptedPayload } from "@aztec/wallet-sdk/crypto";
import type { ConnectRequest, DiscoveryRequest } from "@aztec/wallet-sdk/types";

/**
 * Content script that acts as a pure message relay between the web page and the background script.
 *
 * Security model:
 * - Content script NEVER has access to private keys or shared secrets
 * - All encryption/decryption happens in the background script (service worker)
 * - Content script only forwards opaque encrypted payloads
 * - This minimizes the attack surface since content scripts run in the page context
 */

/**
 * Stores MessagePort references for each connected dApp.
 * The content script only holds the port for relaying messages,
 * NOT any cryptographic material.
 */
interface PortConnection {
  port: MessagePort;
  appId: string;
}

export default defineContentScript({
  matches: ["*://*/*"],
  main() {
    // Map of appId -> MessagePort
    const ports = new Map<string, PortConnection>();

    // Listen for messages from the web page
    window.addEventListener("message", async (event) => {
      // Only accept messages from the same window
      if (event.source !== window) {
        return;
      }

      // SDK sends JSON stringified messages
      let data: DiscoveryRequest | ConnectRequest;
      try {
        data = JSON.parse(event.data);
      } catch {
        // Not a JSON string, ignore
        return;
      }

      if (!data?.type) {
        return;
      }

      switch (data.type) {
        case "aztec-wallet-discovery":
          handleDiscoveryRequest(data as DiscoveryRequest);
          break;

        case "aztec-wallet-connect":
          await handleConnectRequest(data as ConnectRequest, event.ports[0]);
          break;
      }
    });

    // Listen for messages from the background script
    browser.runtime.onMessage.addListener((event: any) => {
      const { content, origin, type, appId } = event;
      if (origin !== "background") {
        return;
      }

      switch (type) {
        case "aztec-wallet-discovery-response":
          window.postMessage(JSON.stringify(content));
          break;

        case "secure-response":
          handleSecureResponse(appId, content);
          break;
      }
    });

    /**
     * Handles wallet discovery requests from the page.
     * Forwards to background script for processing.
     */
    function handleDiscoveryRequest(request: DiscoveryRequest) {
      browser.runtime.sendMessage({
        origin: "content-script",
        type: "aztec-wallet-discovery",
        content: request,
      });
    }

    /**
     * Handles encrypted responses from background.
     * Relays to the page via the stored MessagePort.
     */
    function handleSecureResponse(appId: string, content: EncryptedPayload) {
      const connection = ports.get(appId);
      if (!connection) {
        console.error(`No port found for app ${appId}`);
        return;
      }
      connection.port.postMessage(content);
    }

    /**
     * Handles a connection request from a dApp.
     * Forwards the connect request to background for key derivation,
     * then stores the MessagePort for future message relay.
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
        // Ask background script to establish secure channel (derive shared key)
        const result = await browser.runtime.sendMessage({
          origin: "content-script",
          type: "aztec-wallet-connect",
          content: request,
        });

        if (!result?.success) {
          console.error("Failed to establish secure channel:", result?.error);
          return;
        }

        // Store the port for relaying messages
        ports.set(request.appId, {
          port,
          appId: request.appId,
        });

        // Set up message handler - relay encrypted messages to background
        port.onmessage = (event: MessageEvent<EncryptedPayload>) => {
          browser.runtime.sendMessage({
            origin: "content-script",
            type: "secure-message",
            appId: request.appId,
            content: event.data,
          });
        };

        // Start receiving messages
        port.start();

        console.log(`Message relay established for app ${request.appId}`);
      } catch (err) {
        console.error("Failed to establish connection:", err);
      }
    }
  },
});
