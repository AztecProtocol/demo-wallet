import { app, BrowserWindow, MessageChannelMain, dialog } from "electron";
import { join, dirname } from "node:path";
import started from "electron-squirrel-startup";
import { ipcMain, utilityProcess, type MessagePortMain } from "electron/main";
import { WalletInternalProxy } from "./ipc/wallet-internal-proxy";
import { inspect } from "node:util";
import fs, { mkdirSync, writeFile } from "node:fs";
import os from "node:os";
import { createServer, type Socket, type Server } from "node:net";
import { WALLET_DATA_DIR, getSocketPath } from "./shared/paths";
import {
  checkSystemWideManifest,
  installNativeMessagingManifests,
} from "./native-messaging";

// Setup logging to file for debugging
mkdirSync(WALLET_DATA_DIR, { recursive: true });
const logFile = join(WALLET_DATA_DIR, "aztec-keychain-debug.log");
const originalConsoleLog = console.log;
const originalConsoleError = console.error;

function writeLog(level: string, ...args: any[]) {
  const timestamp = new Date().toISOString();
  const message = `[${timestamp}] [${level}] ${args
    .map((arg) => (typeof arg === "object" ? JSON.stringify(arg) : String(arg)))
    .join(" ")}\n`;

  fs.appendFileSync(logFile, message);
  if (level === "ERROR") {
    originalConsoleError(...args);
  } else {
    originalConsoleLog(...args);
  }
}

console.log = (...args: any[]) => writeLog("INFO", ...args);
console.error = (...args: any[]) => writeLog("ERROR", ...args);

console.log(`=== App Starting ===`);
console.log(`Log file: ${logFile}`);

// Replace placeholder paths with actual runtime paths for packaged app
if (app.isPackaged) {
  const resourcesPath = process.resourcesPath;

  console.log("=== Path Resolution ===");
  console.log("process.resourcesPath:", resourcesPath);
  console.log("process.cwd():", process.cwd());
  console.log("__dirname:", __dirname);

  // Replace placeholders in environment variables
  if (process.env.BB_WASM_PATH?.includes("__RESOURCES_PATH__")) {
    process.env.BB_WASM_PATH = process.env.BB_WASM_PATH.replace(
      "__RESOURCES_PATH__",
      resourcesPath
    );
  }
  if (process.env.BB_BINARY_PATH?.includes("__RESOURCES_PATH__")) {
    process.env.BB_BINARY_PATH = process.env.BB_BINARY_PATH.replace(
      "__RESOURCES_PATH__",
      resourcesPath
    );
  }

  if (process.env.BB_NAPI_PATH?.includes("__RESOURCES_PATH__")) {
    process.env.BB_NAPI_PATH = process.env.BB_NAPI_PATH.replace(
      "__RESOURCES_PATH__",
      resourcesPath
    );
  }

  if (process.env.NATIVE_HOST_PATH?.includes("__RESOURCES_PATH__")) {
    process.env.NATIVE_HOST_PATH = process.env.NATIVE_HOST_PATH.replace(
      "__RESOURCES_PATH__",
      resourcesPath
    );
  }

  // Verify binary exists and is executable
  try {
    const stats = fs.statSync(process.env.BB_BINARY_PATH!);
    console.log(
      `BB binary found: ${stats.size} bytes, mode: ${stats.mode.toString(8)}`
    );
  } catch (error: any) {
    console.error("BB binary check failed:", error.message);
  }

  // Ensure BB_WORKING_DIRECTORY is set to a writable location
  const bbWorkingDir = join(os.tmpdir(), "bb");
  process.env.BB_WORKING_DIRECTORY = bbWorkingDir;

  // Set CRS_PATH to the same directory so bb can write .bb-crs there
  process.env.CRS_PATH = bbWorkingDir;

  // Create the working directory if it doesn't exist
  try {
    if (!fs.existsSync(bbWorkingDir)) {
      fs.mkdirSync(bbWorkingDir, { recursive: true });
      console.log("Created BB_WORKING_DIRECTORY");
    }
  } catch (error: any) {
    console.error("Failed to create BB_WORKING_DIRECTORY:", error.message);
  }
}

console.log("CRS_PATH:", process.env.BB_WORKING_DIRECTORY);
console.log("BB_WORKING_DIRECTORY:", process.env.BB_WORKING_DIRECTORY);
console.log("BB_BINARY_PATH:", process.env.BB_BINARY_PATH);
console.log("BB_NAPI_PATH:", process.env.BB_NAPI_PATH);
console.log("BB_WASM_PATH:", process.env.BB_WASM_PATH);
console.log("NATIVE_HOST_PATH:", process.env.NATIVE_HOST_PATH);
console.log("CHROME_EXTENSION_ID:", process.env.CHROME_EXTENSION_ID);

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  app.quit();
}

// Store main window reference at module level for focus/show operations
let mainWindow: BrowserWindow | null = null;

/**
 * Shows and focuses the main window.
 * Used to bring the app to the foreground when user interaction is needed.
 */
function focusMainWindow(): boolean {
  if (mainWindow) {
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.show();
    mainWindow.focus();
    return true;
  }
  return false;
}

/**
 * Create IPC socket server for communication with native messaging host.
 * Uses Unix socket (macOS/Linux) or named pipe (Windows).
 * Protocol: newline-delimited JSON.
 *
 * The native host is a pure relay - messages are passed through as-is.
 * Compression is handled at the SDK level (compress before encrypt, decompress after decrypt).
 */
function createIpcServer(externalPort: MessagePortMain): Server {
  const socketPath = getSocketPath();

  // Ensure socket directory exists (for Unix sockets)
  if (process.platform !== "win32") {
    const socketDir = dirname(socketPath);
    if (!fs.existsSync(socketDir)) {
      fs.mkdirSync(socketDir, { recursive: true });
    }
    // Clean up stale socket file
    try {
      fs.unlinkSync(socketPath);
    } catch {
      // Socket file doesn't exist, that's fine
    }
  }

  // Track connected native host socket
  let activeSocket: Socket | null = null;

  // Listen for wallet responses and forward to native host
  externalPort.on("message", (event) => {
    if (event.data.origin === "wallet") {
      if (activeSocket && !activeSocket.destroyed) {
        // Forward the JSON string directly
        activeSocket.write(event.data.content + "\n");
      } else {
        console.error("No active native host connection to send response to");
      }
    }
  });

  /**
   * Handle special messages that should be processed by the main process
   * rather than forwarded to the wallet worker.
   * Returns true if the message was handled, false otherwise.
   */
  function handleMainProcessMessage(message: any, socket: Socket): boolean {
    if (message.type === "focus-app") {
      console.log("Received focus-app request from extension");
      const success = focusMainWindow();
      // Send response back to extension
      const response = JSON.stringify({ type: "focus-app-response", success });
      socket.write(response + "\n");
      return true;
    }
    return false;
  }

  const server = createServer((socket: Socket) => {
    console.log("Native messaging host connected");
    activeSocket = socket;

    let buffer = "";

    // Forward messages from native host to wallet-worker
    socket.on("data", (data: Buffer) => {
      buffer += data.toString("utf-8");

      // Process complete newline-delimited messages
      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);

        if (line.trim()) {
          // Check if this is a message for the main process
          try {
            const message = JSON.parse(line);
            if (handleMainProcessMessage(message, socket)) {
              continue; // Message was handled by main process, don't forward
            }
          } catch {
            // Not valid JSON or parsing failed, forward anyway
          }

          // Forward JSON string directly to wallet-worker
          externalPort.postMessage({
            origin: "native-host",
            content: line,
          });
        }
      }
    });

    socket.on("close", () => {
      console.log("Native messaging host disconnected");
      if (activeSocket === socket) {
        activeSocket = null;
      }
    });

    socket.on("error", (err) => {
      console.error("Native host socket error:", err);
    });
  });

  server.on("error", (err) => {
    console.error("IPC server error:", err);
  });

  server.listen(socketPath, () => {
    console.log(`IPC server listening at ${socketPath}`);
  });

  return server;
}

const createWindow = () => {
  // Create the browser window and store in module-level variable
  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      sandbox: false,
    },
  });

  // Clean up reference when window is closed
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  // and load the index.html of the app.
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(
      join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`)
    );
  }

  // Open the DevTools.
  if (!app.isPackaged) {
    mainWindow.webContents.openDevTools();
  }
  return mainWindow;
};

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.on("ready", async () => {
  const nativeHostPath = process.env.NATIVE_HOST_PATH || "";
  const chromeExtensionId = process.env.CHROME_EXTENSION_ID || "";

  // Check system-wide manifest exists in dev mode (WXT uses custom user-data-dir)
  checkSystemWideManifest(nativeHostPath, chromeExtensionId);

  // Install native messaging manifests on startup
  installNativeMessagingManifests(nativeHostPath, chromeExtensionId);

  createWindow();
  const { port1: externalPort1, port2: externalPort2 } =
    new MessageChannelMain();
  const { port1: internalPort1, port2: internalPort2 } =
    new MessageChannelMain();
  const { port1: walletLogPort1, port2: walletLogPort2 } =
    new MessageChannelMain();

  // Create IPC server for native messaging host communication
  const ipcServer = createIpcServer(externalPort1);

  // Start the external port to receive messages from wallet-worker
  externalPort1.start();

  // Convert all process.env values to strings (Electron requirement)
  const filteredEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && value !== null) {
      // Convert to string to handle cases where env vars are numbers
      filteredEnv[key] = String(value);
    }
  }

  const wallet = utilityProcess.fork(join(__dirname, "wallet-worker.js"), [], {
    env: filteredEnv,
  });

  wallet.postMessage({ type: "ports" }, [
    externalPort2,
    internalPort1,
    walletLogPort1,
  ]);

  wallet.on("exit", () => {
    console.error("wallet process died");
    process.exit(1);
  });

  // Clean up on app quit
  app.on("will-quit", () => {
    ipcServer.close();
    wallet.kill();
  });

  walletLogPort2.start();
  walletLogPort2.on("message", (event) => {
    const { type, args } = event.data;
    if (type !== "log") {
      return;
    }
    const sanitizedArgs = JSON.parse(args);
    const dataObject = sanitizedArgs.pop();
    console.log(`${sanitizedArgs.join(" ")} ${inspect(dataObject)}`);
  });

  const walletProxy = WalletInternalProxy.create(internalPort2);
  walletProxy.onWalletUpdate((event) => {
    mainWindow?.webContents.send("wallet-update", event);
  });
  walletProxy.onAuthorizationRequest((event) => {
    mainWindow?.webContents.send("authorization-request", event);
    // Focus the window when authorization is needed
    focusMainWindow();
  });
  walletProxy.onProofDebugExportRequest((event) => {
    mainWindow?.webContents.send("proof-debug-export-request", event);
  });
  const internalMethods = [
    "getAccounts",
    "getAddressBook",
    "registerSender",
    "getTxReceipt",
    "createAccount",
    "getInteractions",
    "getExecutionTrace",
    "resolveAuthorization",
    "listAuthorizedApps",
    "getAppAuthorizations",
    "updateAccountAuthorization",
    "updateAddressBookAuthorization",
    "revokeAuthorization",
    "revokeAppAuthorizations",
  ];
  for (const method of internalMethods) {
    ipcMain.handle(method, async (_event, args) => {
      return walletProxy[method](...(args ? JSON.parse(args) : []));
    });
  }

  // IPC handler for saving proof debug data
  ipcMain.handle("saveProofDebugData", async (_event, data: string) => {
    if (!mainWindow) {
      return { success: false, error: "No main window available" };
    }
    const result = await dialog.showSaveDialog(mainWindow, {
      title: "Save Proof Debug Data",
      defaultPath: `ivc-inputs-${Date.now()}.msgpack`,
      filters: [
        { name: "MessagePack", extensions: ["msgpack"] },
        { name: "All Files", extensions: ["*"] },
      ],
    });

    if (result.canceled || !result.filePath) {
      return { success: false, canceled: true };
    }

    return new Promise((resolve) => {
      // Data is base64 encoded from the renderer
      const buffer = Buffer.from(data, "base64");
      writeFile(result.filePath, buffer, (err) => {
        if (err) {
          console.error("Failed to write debug data:", err);
          resolve({ success: false, error: err.message });
        } else {
          console.log("Debug data saved to:", result.filePath);
          resolve({ success: true, filePath: result.filePath });
        }
      });
    });
  });
});

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
