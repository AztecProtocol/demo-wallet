import "../src/shared/polyfills";
import { BackgroundConnectionHandler } from "@aztec/wallet-sdk/extension/handlers";
import type { WalletResponse } from "@aztec/wallet-sdk/types";
import { WALLET_ID, WALLET_NAME, WALLET_VERSION } from "../src/shared/constants";
import { isAppRemembered, rememberApp } from "../src/background/remembered-apps";
import {
  ensureOffscreen,
  acquireKeepAlive,
  releaseKeepAlive,
  markOffscreenReady,
} from "../src/background/offscreen-lifecycle";
import { enqueueApproval, isApprovalWindowOpen } from "../src/background/approval-window";
import { bumpActivity, onAutoLockFired } from "../src/background/auto-lock";
import { PortClient } from "../src/ipc/port-client";
import { parseEventDetail } from "../src/ipc/parse-event-detail";
import { hasVaultMeta } from "../src/vault/vault-meta";

export default defineBackground(() => {
  let portClient: PortClient | null = null;
  let pendingDappCount = 0;

  async function getPortClient(): Promise<PortClient> {
    await ensureOffscreen();
    if (!portClient) {
      // SW already ensured the offscreen above; skip the round-trip ping.
      portClient = new PortClient({ skipEnsureOffscreen: true });
      portClient.connect();
      portClient.onBroadcast("authorization-request", (payload) => {
        // Wallet-emitted events arrive as `jsonStringify(content)` strings —
        // parse before reading fields. Without this, `req.id` is undefined
        // and the approval window opens with `?requestId=undefined`.
        const req = parseEventDetail(payload) as { id: string; type?: string };
        enqueueApproval({ id: req.id, type: req.type ?? "unknown" });
      });
    }
    return portClient;
  }

  // Open onboarding tab on first install (no vault meta yet).
  chrome.runtime.onInstalled.addListener(async (details) => {
    if (details.reason !== "install") return;
    const initialized = await hasVaultMeta();
    if (!initialized) {
      await chrome.tabs.create({
        url: chrome.runtime.getURL("onboarding.html"),
      });
    }
  });

  const sessionHandler = new BackgroundConnectionHandler(
    {
      walletId: WALLET_ID,
      walletName: WALLET_NAME,
      walletVersion: WALLET_VERSION,
      logger: console,
    },
    {
      sendToTab: (tabId, message) => browser.tabs.sendMessage(tabId, message),
      addContentListener: (handler) => browser.runtime.onMessage.addListener(handler),
    },
    {
      onPendingDiscovery: async (discovery) => {
        const chainId = discovery.chainInfo.chainId.toString();
        const version = discovery.chainInfo.version.toString();
        if (
          await isAppRemembered(discovery.appId, discovery.origin, chainId, version)
        ) {
          sessionHandler.approveDiscovery(discovery.requestId);
        } else {
          chrome.action.openPopup().catch(() => {});
        }
      },
      onSessionEstablished: () => {
        chrome.action.openPopup().catch(() => {});
      },
      onWalletMessage: async (session, message) => {
        // TEMP DEBUG: log every dApp message and what we send back so we can
        // see whether responses leave the SW. Revert once the bug is found.
        console.log("[SW] onWalletMessage", {
          messageId: message.messageId,
          type: message.type,
          sessionId: session.sessionId,
        });
        if (!(await hasVaultMeta())) {
          await sessionHandler.sendResponse(session.sessionId, {
            messageId: message.messageId,
            walletId: WALLET_ID,
            error: {
              message: "Wallet not yet initialized — complete onboarding first",
            },
          });
          return;
        }

        const client = await getPortClient();
        pendingDappCount++;
        acquireKeepAlive();
        await bumpActivity();

        try {
          // If locked, open the popup as an unlock prompt. The dApp call below
          // will reject with "Vault is locked" until the user unlocks.
          const isUnlocked = await client.call<boolean>("vault.isUnlocked", []);
          if (!isUnlocked) {
            chrome.action.openPopup().catch(() => {
              chrome.windows.create({
                url: chrome.runtime.getURL(
                  "popup.html?reason=unlock-for-request",
                ),
                type: "popup",
                width: 380,
                height: 560,
                focused: true,
              });
            });
          }

          const result = await client.call<unknown>(`dapp.${message.type}`, [
            session,
            message,
          ]);
          console.log("[SW] dapp call returned", {
            messageId: message.messageId,
            type: message.type,
            resultPreview: typeof result === "object" ? Object.keys(result ?? {}) : typeof result,
          });
          const response: WalletResponse = {
            messageId: message.messageId,
            walletId: WALLET_ID,
            result,
          };
          await sessionHandler.sendResponse(session.sessionId, response);
          console.log("[SW] sendResponse OK", { messageId: message.messageId });
        } catch (err) {
          const e = err as Error;
          console.error("[SW] dapp call failed", {
            messageId: message.messageId,
            type: message.type,
            error: e.message,
          });
          const response: WalletResponse = {
            messageId: message.messageId,
            walletId: WALLET_ID,
            error: { message: e.message ?? String(err) },
          };
          await sessionHandler.sendResponse(session.sessionId, response);
          console.log("[SW] sendResponse(error) OK", { messageId: message.messageId });
        } finally {
          pendingDappCount--;
          releaseKeepAlive();
        }
      },
    },
  );
  sessionHandler.initialize();

  onAutoLockFired(async () => {
    // Don't lock while a user is mid-approval or while a dApp request is in flight.
    if (isApprovalWindowOpen() || pendingDappCount > 0) {
      await bumpActivity();
      return;
    }
    const client = await getPortClient();
    await client.call("vault.lock", []);
  });

  // Bump activity whenever a UI surface connects (popup/expanded/approval open).
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name === "ui-activity") void bumpActivity();
  });

  // Multiplexed onMessage handler. Each `type` is a distinct UI ↔ SW request.
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    const type = (msg as { type?: string })?.type;
    if (type === "ensure-offscreen") {
      ensureOffscreen().then(
        () => sendResponse({ ok: true }),
        (err: Error) => sendResponse({ ok: false, error: err.message }),
      );
      return true;
    }
    if (type === "offscreen-ready") {
      markOffscreenReady();
      sendResponse({ ok: true });
      return false;
    }
    if (type === "get-pending-discoveries") {
      // Surface the SDK-managed pending list to the popup so it can render
      // approve/reject UI. We expose only the fields the popup needs.
      const discoveries = sessionHandler.getPendingDiscoveries().map((d) => ({
        requestId: d.requestId,
        origin: d.origin,
        appId: d.appId,
        chainId: d.chainInfo.chainId.toString(),
        version: d.chainInfo.version.toString(),
      }));
      sendResponse({ ok: true, discoveries });
      return false;
    }
    if (type === "approve-discovery") {
      const { requestId, remember } = msg as {
        requestId: string;
        remember?: boolean;
      };
      const discovery = sessionHandler
        .getPendingDiscoveries()
        .find((d) => d.requestId === requestId);
      const ok = sessionHandler.approveDiscovery(requestId);
      if (ok && remember && discovery) {
        void rememberApp(
          discovery.appId,
          discovery.origin,
          discovery.chainInfo.chainId.toString(),
          discovery.chainInfo.version.toString(),
        );
      }
      sendResponse({ ok });
      return false;
    }
    if (type === "reject-discovery") {
      const { requestId } = msg as { requestId: string };
      const ok = sessionHandler.rejectDiscovery(requestId);
      sendResponse({ ok });
      return false;
    }
    if (type === "get-active-sessions") {
      // Active (post-key-exchange) dApp sessions. Each carries a
      // `verificationHash` the popup can render as emojis for the user to
      // compare with what the dApp displays — that's the security check that
      // the ECDH handshake produced the same shared secret on both sides.
      const sessions = sessionHandler.getActiveSessions().map((s) => ({
        sessionId: s.sessionId,
        origin: s.origin,
        appId: s.appId,
        verificationHash: s.verificationHash,
        chainId: s.chainInfo.chainId.toString(),
        version: s.chainInfo.version.toString(),
      }));
      sendResponse({ ok: true, sessions });
      return false;
    }
    return false;
  });

  browser.tabs.onRemoved.addListener((tabId) => sessionHandler.terminateForTab(tabId));
  browser.webNavigation.onBeforeNavigate.addListener((details) => {
    if (details.frameId === 0) sessionHandler.terminateForTab(details.tabId);
  });
});
