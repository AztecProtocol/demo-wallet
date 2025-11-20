export default defineBackground(() => {
  let webSocket: WebSocket | null = null;
  const pendingNetworkChecks = new Map<string, { resolve: (value: boolean) => void; timeout: ReturnType<typeof setTimeout> }>();

  browser.runtime.onMessage.addListener((event: any, sender, sendResponse) => {
    const parsed = typeof event === 'string' ? JSON.parse(event) : event;
    const { content, origin, type, chainInfo } = parsed;

    // Handle network support check from content script
    if (type === '__check_network_support') {
      // Check with wallet worker
      if (!webSocket || webSocket.readyState !== WebSocket.OPEN) {
        sendResponse(false);
        return;
      }

      const messageId = crypto.randomUUID();
      const timeout = setTimeout(() => {
        sendResponse(false);
        pendingNetworkChecks.delete(messageId);
      }, 500); // 500ms timeout for network check

      pendingNetworkChecks.set(messageId, {
        resolve: (value: boolean) => {
          sendResponse(value);
        },
        timeout
      });

      webSocket.send(JSON.stringify({
        type: '__check_network_support',
        messageId,
        chainInfo
      }));

      return true; // Indicates we'll respond asynchronously
    }

    // Handle wallet method calls
    if (webSocket && origin === "injected") {
      webSocket.send(content);
    }
  });

  function connect() {
    return new Promise((resolve, reject) => {
      webSocket = new WebSocket("ws://localhost:8765");
      webSocket.onopen = () => {
        console.log("websocket open");
        keepAlive();
        resolve(true);
      };

      webSocket.onmessage = async (event) => {
        console.log("websocket message", event);
        const data = JSON.parse(event.data);

        // Handle network support check response
        if (data.type === '__network_support_response') {
          const pending = pendingNetworkChecks.get(data.messageId);
          if (pending) {
            clearTimeout(pending.timeout);
            pending.resolve(data.result === true);
            pendingNetworkChecks.delete(data.messageId);
          }
          return;
        }

        // Forward wallet method responses to content script
        const [tab] = await browser.tabs.query({
          active: true,
          currentWindow: true,
        });
        if (!tab?.id) {
          console.error("No active tab found");
          return;
        }
        browser.tabs.sendMessage(tab.id, {
          origin: "background",
          content: data,
        });
      };

      webSocket.onclose = (event) => {
        console.log("websocket connection closed");
        webSocket = null;
        pendingNetworkChecks.forEach(({ timeout }) => clearTimeout(timeout));
        pendingNetworkChecks.clear();
        connect();
      };
    });
  }

  function keepAlive() {
    const keepAliveIntervalId = setInterval(
      () => {
        if (webSocket) {
          webSocket.send("keepalive");
        } else {
          clearInterval(keepAliveIntervalId);
        }
      },
      // Set the interval to 20 seconds to prevent the service worker from becoming inactive.
      20 * 1000
    );
  }
  connect();
});
