export default defineContentScript({
  matches: ["*://*/*"],
  main() {
    window.addEventListener("message", async (event) => {
      // We only accept messages from ourselves
      if (event.source !== window) {
        return;
      }

      const { data } = event;

      let parsed;

      try {
        parsed = JSON.parse(data);
      } catch {}

      // Handle discovery request
      if (parsed?.type === "aztec-wallet-discovery") {
        const { requestId, chainInfo } = parsed;

        // Check if wallet supports this chain/version
        const isSupported = await browser.runtime.sendMessage({
          type: "__check_network_support",
          chainInfo,
        });

        if (isSupported) {
          window.postMessage(
            {
              type: "aztec-wallet-discovery-response",
              requestId,
              walletInfo: {
                id: "aztec-keychain",
                name: "Aztec Keychain",
                version: browser.runtime.getManifest().version,
              },
            },
            "*"
          );
        }
        // If not supported, don't respond at all
        return;
      }

      // Handle wallet method calls
      if (data.result || data.error) {
        return;
      }

      const { data: content } = event;
      browser.runtime.sendMessage({ origin: "injected", content });
    });

    browser.runtime.onMessage.addListener((event: any) => {
      console.log("content received message", event);
      const { content, origin } = event;
      if (origin !== "background") {
        return;
      }
      window.postMessage(content);
    });
  },
});
