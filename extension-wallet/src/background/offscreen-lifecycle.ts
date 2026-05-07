import { KEEP_ALIVE_PORT_NAME } from "../ipc/port-envelope";

const OFFSCREEN_URL = "offscreen.html";

/** True if running on Chromium-based browsers that support `chrome.offscreen`. */
function hasOffscreenApi(): boolean {
  return typeof chrome !== "undefined" && typeof chrome.offscreen !== "undefined";
}

let creating: Promise<void> | null = null;
let firefoxOffscreenWindowId: number | null = null;

// `chrome.offscreen.createDocument` resolves when the document is created,
// not after its scripts have run. Without this gate, the SW can return from
// `ensureOffscreen()` before `WalletHost.start()` has registered its
// `onConnect` listener — the next UI port-open finds no listener and hangs.
// The offscreen's `WalletHost.start()` calls `notifyOffscreenReady()` (via
// `chrome.runtime.sendMessage({ type: "offscreen-ready" })`) once it's set
// up; we resolve `readyResolver` then. Each spawn cycle gets a fresh promise.
let readyPromise: Promise<void> | null = null;
let readyResolver: (() => void) | null = null;

function resetReadyGate() {
  readyPromise = new Promise((resolve) => {
    readyResolver = resolve;
  });
}

/** Called by the SW's onMessage handler when the offscreen reports ready. */
export function markOffscreenReady() {
  readyResolver?.();
  readyResolver = null;
}

export async function ensureOffscreen(): Promise<void> {
  if (creating) {
    await creating;
    if (readyPromise) await readyPromise;
    return;
  }

  if (hasOffscreenApi()) {
    const existing = await chrome.offscreen.hasDocument?.();
    if (existing) {
      // Document is already up; either it signaled ready earlier (and our
      // gate is a no-op), or it's mid-init and we're about to await the
      // signal. Either way, awaiting an already-resolved promise is cheap.
      if (readyPromise) await readyPromise;
      return;
    }

    resetReadyGate();
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
    await readyPromise;
    return;
  }

  // Firefox fallback: open a hidden minimized window. Re-use across calls.
  if (firefoxOffscreenWindowId !== null) {
    if (readyPromise) await readyPromise;
    return;
  }
  resetReadyGate();
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
  await readyPromise;
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
