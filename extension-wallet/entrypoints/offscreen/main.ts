import "../../src/shared/polyfills";
import { WalletHost } from "../../src/offscreen/wallet-host";

const host = new WalletHost();
host.start();
console.log("[offscreen] Wallet host started");

// Tell the SW our PortServer is registered and ready to receive UI connections.
// The SW gates `ensureOffscreen()` on this signal — without it, the UI's
// runtime.connect arrives before our onConnect listener is wired up.
chrome.runtime.sendMessage({ type: "offscreen-ready" }).catch(() => {
  // SW may have suspended in the brief window between our boot and this call;
  // it'll re-spawn us next time and the new instance's signal will be heard.
});
