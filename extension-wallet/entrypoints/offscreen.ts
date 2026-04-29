import { WalletHost } from "../src/offscreen/wallet-host";

const host = new WalletHost();
host.start();
console.log("[offscreen] Wallet host started");
