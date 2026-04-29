import { BackgroundConnectionHandler } from "@aztec/wallet-sdk/extension/handlers";
import type { WalletResponse } from "@aztec/wallet-sdk/types";
import { WALLET_ID, WALLET_NAME, WALLET_VERSION } from "../src/shared/constants";
import { isAppRemembered } from "../src/background/remembered-apps";
import {
  ensureOffscreen,
  acquireKeepAlive,
  releaseKeepAlive,
} from "../src/background/offscreen-lifecycle";
import { enqueueApproval, isApprovalWindowOpen } from "../src/background/approval-window";
import { bumpActivity, onAutoLockFired } from "../src/background/auto-lock";
import { PortClient } from "../src/ipc/port-client";
import { hasVaultMeta } from "../src/vault/vault-meta";

export default defineBackground(() => {
  let portClient: PortClient | null = null;
  let pendingDappCount = 0;

  async function getPortClient(): Promise<PortClient> {
    await ensureOffscreen();
    if (!portClient) {
      portClient = new PortClient();
      portClient.connect();
      portClient.onBroadcast("authorization-request", (payload) => {
        const req = payload as { id: string; type?: string };
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
        url: chrome.runtime.getURL("onboarding/index.html"),
      });
    }
  });

  const sessionHandler = new BackgroundConnectionHandler(
    { walletId: WALLET_ID, walletName: WALLET_NAME, walletVersion: WALLET_VERSION },
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
                  "popup/index.html?reason=unlock-for-request",
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
          const response: WalletResponse = {
            messageId: message.messageId,
            walletId: WALLET_ID,
            result,
          };
          await sessionHandler.sendResponse(session.sessionId, response);
        } catch (err) {
          const e = err as Error;
          const response: WalletResponse = {
            messageId: message.messageId,
            walletId: WALLET_ID,
            error: { message: e.message ?? String(err) },
          };
          await sessionHandler.sendResponse(session.sessionId, response);
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

  browser.tabs.onRemoved.addListener((tabId) => sessionHandler.terminateForTab(tabId));
  browser.webNavigation.onBeforeNavigate.addListener((details) => {
    if (details.frameId === 0) sessionHandler.terminateForTab(details.tabId);
  });
});
