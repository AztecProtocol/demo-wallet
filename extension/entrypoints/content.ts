import { ContentScriptConnectionHandler } from "@aztec/wallet-sdk/extension/handlers";

/**
 * Content script that acts as a pure message relay between the web page and the background script.
 *
 * Uses ContentScriptConnectionHandler from wallet-sdk for the connection logic.
 *
 * Security model:
 * - Content script NEVER has access to private keys or shared secrets
 * - All encryption/decryption happens in the background script (service worker)
 * - Content script only forwards opaque encrypted payloads
 * - This minimizes the attack surface since content scripts run in the page context
 */
export default defineContentScript({
  matches: ["*://*/*"],
  main() {
    const handler = new ContentScriptConnectionHandler({
      sendToBackground: (message) => browser.runtime.sendMessage(message),
      addBackgroundListener: (listener) =>
        browser.runtime.onMessage.addListener(listener),
    });

    handler.start();
  },
});
