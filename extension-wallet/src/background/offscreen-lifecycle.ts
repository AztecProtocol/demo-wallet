import { KEEP_ALIVE_PORT_NAME } from "../ipc/port-envelope";

const OFFSCREEN_URL = "offscreen.html";

/** True if running on Chromium-based browsers that support `chrome.offscreen`. */
function hasOffscreenApi(): boolean {
  return typeof chrome !== "undefined" && typeof chrome.offscreen !== "undefined";
}

let creating: Promise<void> | null = null;
let firefoxOffscreenWindowId: number | null = null;

export async function ensureOffscreen(): Promise<void> {
  if (creating) {
    await creating;
    return;
  }

  if (hasOffscreenApi()) {
    const existing = await chrome.offscreen.hasDocument?.();
    if (existing) return;

    creating = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_URL,
        reasons: ["DOM_PARSER" as chrome.offscreen.Reason],
        justification: "Host wallet runtime (PXE, WalletDB, vault)",
      })
      .finally(() => {
        creating = null;
      });
    await creating;
    return;
  }

  // Firefox fallback: open a hidden minimized window. Re-use across calls.
  if (firefoxOffscreenWindowId !== null) return;
  creating = (async () => {
    const win = await chrome.windows.create({
      url: chrome.runtime.getURL(OFFSCREEN_URL),
      state: "minimized",
      focused: false,
    });
    firefoxOffscreenWindowId = win.id ?? null;
  })().finally(() => {
    creating = null;
  });
  await creating;
}

const keepAliveCount = { n: 0, port: null as chrome.runtime.Port | null };

export function acquireKeepAlive(): void {
  if (keepAliveCount.n === 0) {
    keepAliveCount.port = chrome.runtime.connect({ name: KEEP_ALIVE_PORT_NAME });
  }
  keepAliveCount.n++;
}

export function releaseKeepAlive(): void {
  keepAliveCount.n = Math.max(0, keepAliveCount.n - 1);
  if (keepAliveCount.n === 0) {
    keepAliveCount.port?.disconnect();
    keepAliveCount.port = null;
  }
}
