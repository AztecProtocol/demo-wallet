/**
 * Shared path utilities used by both main process and native host.
 */

import { homedir } from "os";
import { join } from "path";

/**
 * Base directory for all wallet data (logs, PXE data, socket, etc.)
 */
export const WALLET_DATA_DIR = join(homedir(), "keychain");

/**
 * Get the platform-specific socket path for IPC with native messaging host.
 */
export function getSocketPath(): string {
  if (process.platform === "win32") {
    return "\\\\.\\pipe\\aztec-keychain-wallet";
  }
  return join(WALLET_DATA_DIR, "wallet.sock");
}
