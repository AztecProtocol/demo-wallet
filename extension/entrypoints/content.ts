import type { EncryptedPayload } from "@aztec/wallet-sdk/crypto";
import type {
  DiscoveryRequest,
  DiscoveryResponse,
} from "@aztec/wallet-sdk/types";

/**
 * Content script that acts as a pure message relay between the web page and the background script.
 *
 * Security model:
 * - Content script NEVER has access to private keys or shared secrets
 * - All encryption/decryption happens in the background script (service worker)
 * - Content script only forwards opaque encrypted payloads
 * - This minimizes the attack surface since content scripts run in the page context
 *
 * New flow (unified discovery + connection):
 * 1. Page sends discovery request with dApp's public key
 * 2. Content script forwards to background, which derives shared key
 * 3. Content script creates MessageChannel, sends response + port2 to page
 * 4. Content script keeps port1 for relaying encrypted messages
 */

/**
 * Stores MessagePort references for each discovery request.
 * The content script only holds the port for relaying messages,
 * NOT any cryptographic material.
 */
interface PortConnection {
  port: MessagePort;
  requestId: string;
}

export default defineContentScript({
  matches: ["*://*/*"],
  main() {
    // Map of requestId -> MessagePort (port1, for receiving from page)
    const ports = new Map<string, PortConnection>();

    // Listen for messages from the web page
    window.addEventListener("message", async (event) => {
      // Only accept messages from the same window
      if (event.source !== window) {
        return;
      }

      // SDK sends JSON stringified messages
      let data: DiscoveryRequest;
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
          await handleDiscoveryRequest(data as DiscoveryRequest);
          break;
      }
    });

    // Listen for messages from the background script
    browser.runtime.onMessage.addListener((event: any) => {
      const { content, origin, type, requestId } = event;
      if (origin !== "background") {
        return;
      }

      switch (type) {
        case "secure-response":
          handleSecureResponse(requestId, content);
          break;
      }
    });

    /**
     * Handles wallet discovery requests from the page.
     * Now also establishes the MessageChannel for secure communication.
     */
    async function handleDiscoveryRequest(request: DiscoveryRequest) {
      try {
        // Ask background script to handle discovery (derives shared key)
        const result = await browser.runtime.sendMessage({
          origin: "content-script",
          type: "aztec-wallet-discovery",
          content: request,
        });

        if (!result?.success) {
          return;
        }

        const response: DiscoveryResponse = result.response;

        // Create MessageChannel for secure communication
        const channel = new MessageChannel();

        // Store port1 for relaying messages from page to background
        ports.set(request.requestId, {
          port: channel.port1,
          requestId: request.requestId,
        });

        // Set up message handler - relay encrypted messages to background
        channel.port1.onmessage = (event: MessageEvent<EncryptedPayload>) => {
          browser.runtime.sendMessage({
            origin: "content-script",
            type: "secure-message",
            requestId: request.requestId,
            content: event.data,
          });
        };

        // Start receiving messages
        channel.port1.start();

        // Send discovery response to page with port2
        window.postMessage(JSON.stringify(response), "*", [channel.port2]);
      } catch {
        // Discovery failed silently
      }
    }

    /**
     * Handles encrypted responses from background.
     * Relays to the page via the stored MessagePort.
     */
    function handleSecureResponse(
      requestId: string,
      content: EncryptedPayload
    ) {
      const connection = ports.get(requestId);
      if (!connection) {
        console.error(`No port found for requestId ${requestId}`);
        return;
      }
      connection.port.postMessage(content);
    }
  },
});
