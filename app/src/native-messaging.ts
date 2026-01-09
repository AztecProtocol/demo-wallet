/**
 * Native messaging utilities for browser extension communication.
 *
 * This module handles:
 * - Native messaging manifest installation for Firefox and Chrome
 * - System-wide manifest validation for WXT dev mode
 * - Platform-specific paths and registry keys (Windows)
 */

import { app } from "electron";
import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";

// Native messaging configuration
export const NATIVE_HOST_NAME = "com.aztec.keychain";
const FIREFOX_EXTENSION_ID = "aztec-keychain@aztec.network";

/**
 * Get the path to the native host binary.
 * Path is set via NATIVE_HOST_PATH env var from vite.main.config.ts
 */
export function getNativeHostBinaryPath(): string {
  return process.env.NATIVE_HOST_PATH || "";
}

/**
 * Get the system-wide native messaging manifest path for Chrome.
 * This is the location Chrome checks when running with a custom --user-data-dir
 * (which WXT uses in dev mode).
 */
function getSystemWideManifestPath(): string | null {
  switch (process.platform) {
    case "darwin":
      return "/Library/Google/Chrome/NativeMessagingHosts";
    case "linux":
      return "/etc/opt/chrome/native-messaging-hosts";
    default:
      return null; // Windows uses registry
  }
}

/**
 * Check if the native messaging manifest exists in the system-wide location.
 * In dev mode with WXT, Chrome runs with a custom --user-data-dir and only
 * checks the system-wide location for native messaging hosts.
 *
 * Exits with error code 1 and detailed instructions if manifest is missing.
 */
export function checkSystemWideManifest(): void {
  // Only check in dev mode
  if (app.isPackaged) {
    return;
  }

  const systemPath = getSystemWideManifestPath();
  if (!systemPath) {
    return; // Windows uses registry, different handling needed
  }

  const manifestPath = join(systemPath, `${NATIVE_HOST_NAME}.json`);

  if (!fs.existsSync(manifestPath)) {
    const nativeHostPath = getNativeHostBinaryPath();
    const extensionId = process.env.CHROME_EXTENSION_ID || "<EXTENSION_ID>";

    const manifest = JSON.stringify(
      {
        name: NATIVE_HOST_NAME,
        description: "Aztec Keychain Native Messaging Host",
        path: nativeHostPath,
        type: "stdio",
        allowed_origins: [`chrome-extension://${extensionId}/`],
      },
      null,
      2
    );

    console.error("");
    console.error(
      "╔══════════════════════════════════════════════════════════════════════════════╗"
    );
    console.error(
      "║                                                                              ║"
    );
    console.error(
      "║   ⚠️  NATIVE MESSAGING MANIFEST NOT FOUND IN SYSTEM-WIDE LOCATION ⚠️          ║"
    );
    console.error(
      "║                                                                              ║"
    );
    console.error(
      "╠══════════════════════════════════════════════════════════════════════════════╣"
    );
    console.error(
      "║                                                                              ║"
    );
    console.error(
      "║   When using WXT dev mode, Chrome runs with a custom --user-data-dir and    ║"
    );
    console.error(
      "║   only checks the SYSTEM-WIDE location for native messaging hosts.          ║"
    );
    console.error(
      "║                                                                              ║"
    );
    console.error(
      "║   The manifest must be installed at:                                         ║"
    );
    console.error(`║   ${manifestPath.padEnd(72)}║`);
    console.error(
      "║                                                                              ║"
    );
    console.error(
      "╠══════════════════════════════════════════════════════════════════════════════╣"
    );
    console.error(
      "║                                                                              ║"
    );
    console.error(
      "║   Run the following command to install the manifest:                         ║"
    );
    console.error(
      "║                                                                              ║"
    );
    console.error(
      `║   sudo mkdir -p ${systemPath.padEnd(54)}║`
    );
    console.error(
      "║                                                                              ║"
    );
    console.error(
      "║   Then create the manifest file with:                                        ║"
    );
    console.error(
      "║                                                                              ║"
    );
    console.error(
      `║   sudo tee ${manifestPath} << 'EOF'`.padEnd(79) + "║"
    );
    console.error(`║   ${manifest.split("\n")[0].padEnd(74)}║`);
    console.error(`║   ${manifest.split("\n")[1].padEnd(74)}║`);
    console.error(`║   ${manifest.split("\n")[2].padEnd(74)}║`);
    console.error(`║   ${manifest.split("\n")[3].padEnd(74)}║`);
    console.error(`║   ${manifest.split("\n")[4].padEnd(74)}║`);
    console.error(`║   ${manifest.split("\n")[5].padEnd(74)}║`);
    console.error(`║   ${manifest.split("\n")[6].padEnd(74)}║`);
    console.error(`║   ${manifest.split("\n")[7].padEnd(74)}║`);
    console.error(`║   ${manifest.split("\n")[8].padEnd(74)}║`);
    console.error("║   EOF".padEnd(79) + "║");
    console.error(
      "║                                                                              ║"
    );
    console.error(
      "╚══════════════════════════════════════════════════════════════════════════════╝"
    );
    console.error("");

    // Exit with error
    process.exit(1);
  }

  console.log(`System-wide native messaging manifest found: ${manifestPath}`);
}

/**
 * Get native messaging manifest directories for each browser.
 */
function getManifestPaths(): { firefox: string[]; chrome: string[] } {
  const home = os.homedir();
  const paths = { firefox: [] as string[], chrome: [] as string[] };

  switch (process.platform) {
    case "darwin":
      paths.firefox.push(
        join(home, "Library/Application Support/Mozilla/NativeMessagingHosts")
      );
      paths.chrome.push(
        join(
          home,
          "Library/Application Support/Google/Chrome/NativeMessagingHosts"
        )
      );
      paths.chrome.push(
        join(home, "Library/Application Support/Chromium/NativeMessagingHosts")
      );
      break;

    case "linux":
      paths.firefox.push(join(home, ".mozilla/native-messaging-hosts"));
      paths.chrome.push(
        join(home, ".config/google-chrome/NativeMessagingHosts")
      );
      paths.chrome.push(join(home, ".config/chromium/NativeMessagingHosts"));
      break;

    case "win32":
      // Windows manifests go in AppData, registry points to them
      const appData = join(home, "AppData", "Local", "AztecKeychain");
      paths.firefox.push(appData);
      paths.chrome.push(appData);
      break;
  }

  return paths;
}

/**
 * Create Firefox native messaging manifest.
 */
function createFirefoxManifest(nativeHostPath: string): object {
  return {
    name: NATIVE_HOST_NAME,
    description: "Aztec Keychain Native Messaging Host",
    path: nativeHostPath,
    type: "stdio",
    allowed_extensions: [FIREFOX_EXTENSION_ID],
  };
}

/**
 * Create Chrome native messaging manifest.
 */
function createChromeManifest(
  nativeHostPath: string,
  extensionId: string
): object {
  return {
    name: NATIVE_HOST_NAME,
    description: "Aztec Keychain Native Messaging Host",
    path: nativeHostPath,
    type: "stdio",
    allowed_origins: [`chrome-extension://${extensionId}/`],
  };
}

/**
 * Install Windows registry keys for native messaging.
 */
function installWindowsRegistryKeys(paths: {
  firefox: string[];
  chrome: string[];
}): void {
  const { execSync } = require("child_process");

  // Firefox registry key
  const firefoxManifestPath = join(
    paths.firefox[0],
    `${NATIVE_HOST_NAME}.json`
  );
  try {
    execSync(
      `reg add "HKCU\\Software\\Mozilla\\NativeMessagingHosts\\${NATIVE_HOST_NAME}" /ve /t REG_SZ /d "${firefoxManifestPath}" /f`,
      { stdio: "pipe" }
    );
    console.log("Installed Firefox registry key");
  } catch (err: any) {
    console.error("Failed to install Firefox registry key:", err.message);
  }

  // Chrome registry key
  if (process.env.CHROME_EXTENSION_ID) {
    const chromeManifestPath = join(
      paths.chrome[0],
      `${NATIVE_HOST_NAME}.json`
    );
    try {
      execSync(
        `reg add "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${NATIVE_HOST_NAME}" /ve /t REG_SZ /d "${chromeManifestPath}" /f`,
        { stdio: "pipe" }
      );
      console.log("Installed Chrome registry key");
    } catch (err: any) {
      console.error("Failed to install Chrome registry key:", err.message);
    }
  }
}

/**
 * Install native messaging manifests for all supported browsers.
 * Called on app startup to ensure the extension can communicate with the app.
 */
export function installNativeMessagingManifests(): void {
  const nativeHostPath = getNativeHostBinaryPath();

  // Verify native host binary exists
  if (!fs.existsSync(nativeHostPath)) {
    console.error(`Native host binary not found: ${nativeHostPath}`);
    console.error("Native messaging will not work until the binary is built.");
    return;
  }

  console.log(`Installing native messaging manifests...`);
  console.log(`Native host path: ${nativeHostPath}`);

  const paths = getManifestPaths();

  // Install Firefox manifests
  const firefoxManifest = createFirefoxManifest(nativeHostPath);
  for (const dir of paths.firefox) {
    try {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const manifestPath = join(dir, `${NATIVE_HOST_NAME}.json`);
      fs.writeFileSync(manifestPath, JSON.stringify(firefoxManifest, null, 2));
      console.log(`Installed Firefox manifest: ${manifestPath}`);
    } catch (err: any) {
      console.error(
        `Failed to install Firefox manifest to ${dir}:`,
        err.message
      );
    }
  }

  // Install Chrome manifests (if extension ID is configured)
  if (process.env.CHROME_EXTENSION_ID) {
    const chromeManifest = createChromeManifest(
      nativeHostPath,
      process.env.CHROME_EXTENSION_ID
    );
    for (const dir of paths.chrome) {
      try {
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        const manifestPath = join(dir, `${NATIVE_HOST_NAME}.json`);
        fs.writeFileSync(manifestPath, JSON.stringify(chromeManifest, null, 2));
        console.log(`Installed Chrome manifest: ${manifestPath}`);
      } catch (err: any) {
        console.error(
          `Failed to install Chrome manifest to ${dir}:`,
          err.message
        );
      }
    }
  } else {
    console.log(
      "Chrome extension ID not configured, skipping Chrome manifest installation."
    );
    console.log(
      "In production, set CHROME_EXTENSION_ID env var when building."
    );
  }

  // Windows: Add registry keys
  if (process.platform === "win32") {
    installWindowsRegistryKeys(paths);
  }

  console.log("Native messaging manifest installation complete.");
}
