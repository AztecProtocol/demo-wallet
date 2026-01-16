#!/usr/bin/env node
/**
 * Native Messaging Host for Aztec Keychain.
 *
 * This binary is spawned by the browser when the extension calls
 * browser.runtime.connectNative('com.aztec.keychain').
 *
 * It acts as a bridge between:
 * - The browser extension (via stdin/stdout with length-prefixed JSON)
 * - The Electron app (via Unix socket / named pipe with newline-delimited JSON)
 *
 * Architecture:
 *   Extension ←→ [Native Host (stdio)] ←→ [Electron App (socket)]
 */

import { StdioTransport } from "./stdio.js";
import { IpcClient } from "./ipc-client.js";
import { appendFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

// Debug logging to file (since stderr may cause issues with native messaging)
const LOG_FILE = join(homedir(), "keychain", "native-host.log");
function log(message: string): void {
  const timestamp = new Date().toISOString();
  appendFileSync(LOG_FILE, `[${timestamp}] ${message}\n`);
}

async function main(): Promise<void> {
  log("Native host starting...");

  const stdio = new StdioTransport();
  const ipc = new IpcClient();

  log("Created stdio and ipc instances");

  // Connect to Electron app
  try {
    log("Connecting to Electron app...");
    await ipc.connect();
    log("Connected to Electron app successfully");
    // Notify extension that we're connected to the wallet backend
    stdio.send({
      type: "status",
      status: "connected",
    });
  } catch (err) {
    const errorMsg =
      err instanceof Error
        ? err.message
        : "Failed to connect to Aztec Keychain app";
    log(`Failed to connect: ${errorMsg}`);
    // Send error back to extension before exiting
    stdio.send({
      type: "status",
      status: "disconnected",
      error: { message: errorMsg },
    });
    process.exit(1);
  }

  // Bridge: Extension → Electron
  stdio.onMessage((message) => {
    log(`Extension → Electron: ${JSON.stringify(message)}`);
    ipc.send(message);
  });

  // Bridge: Electron → Extension
  ipc.onMessage((message) => {
    log(`Electron → Extension: ${JSON.stringify(message)}`);
    stdio.send(message);
  });

  // Handle Electron app disconnection
  ipc.onClose(() => {
    log("Electron app disconnected, exiting");
    process.exit(0);
  });

  log("Native host ready and waiting for messages");
}

main().catch((err) => {
  log(`Fatal error: ${err}`);
  process.exit(1);
});
