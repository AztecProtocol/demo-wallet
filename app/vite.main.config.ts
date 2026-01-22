import { defineConfig } from "vite";
import { resolve } from "path";
import { createHash } from "crypto";
import { readFileSync } from "fs";

const isDev = process.env.NODE_ENV !== "production";

/**
 * Compute Chrome extension ID from manifest public key.
 * Chrome's algorithm:
 * 1. Base64 decode the public key to get DER-encoded data
 * 2. SHA256 hash the DER data
 * 3. Take first 128 bits (16 bytes)
 * 4. Encode as base32 using mpdecimal alphabet (a-p)
 */
function computeChromeExtensionId(publicKeyBase64: string): string {
  const derData = Buffer.from(publicKeyBase64, "base64");
  const hash = createHash("sha256").update(derData).digest("hex");

  // Take first 32 hex characters and convert each to 'a' + value
  // This is Chrome's algorithm: each hex digit (0-f) maps to (a-p)
  const first32Chars = hash.substring(0, 32);

  let result = "";
  for (let i = 0; i < first32Chars.length; i++) {
    const hexChar = first32Chars[i];
    const value = parseInt(hexChar, 16); // 0-15
    result += String.fromCharCode(97 + value); // 'a' + value
  }

  return result;
}

/**
 * Extract the manifest key from extension/wxt.config.ts
 */
function getExtensionManifestKey(): string {
  const wxtConfigPath = resolve(__dirname, "../extension/wxt.config.ts");
  const configContent = readFileSync(wxtConfigPath, "utf-8");

  // Extract the key value using regex
  const keyMatch = configContent.match(/key:\s*["']([^"']+)["']/);
  if (!keyMatch) {
    throw new Error("Could not find manifest key in extension/wxt.config.ts");
  }

  return keyMatch[1];
}

// Chrome extension ID derived from the manifest key
// This is stable because we use a fixed key in extension/wxt.config.ts
const CHROME_EXTENSION_ID = isDev
  ? computeChromeExtensionId(getExtensionManifestKey())
  : process.env.CHROME_EXTENSION_ID || "";

const BB_WASM_PATH = isDev
  ? resolve(__dirname, "./bb/barretenberg-threads.wasm.gz")
  : "__RESOURCES_PATH__/bb/barretenberg-threads.wasm.gz";

const BB_BINARY_PATH = isDev
  ? resolve(__dirname, "./bb/bb")
  : "__RESOURCES_PATH__/bb/bb";

const BB_NAPI_PATH = isDev
  ? resolve(__dirname, "./bb/nodejs_module.node")
  : "__RESOURCES_PATH__/bb/nodejs_module.node";

const platform = process.platform;
const arch = process.arch;
const nativeHostBinaryName =
  platform === "win32" ? "native-host.exe" : "native-host";

const NATIVE_HOST_PATH = isDev
  ? resolve(
      __dirname,
      `./dist/native-host/${platform}-${arch}/${nativeHostBinaryName}`,
    )
  : `__RESOURCES_PATH__/${platform}-${arch}/${nativeHostBinaryName}`;

// https://vitejs.dev/config
export default defineConfig({
  define: {
    "process.env": JSON.stringify({
      // Our pino logger gets confused by electron, and tries to use the
      // default nodejs transports in a web worker. This breaks everything since
      // this app runs with nodeIntegration: false,
      // so for the time being I'm using the escape hatch of making @aztec/foundation pino
      // logger think we're in a jest test. Hehe.
      JEST_WORKER_ID: "1",
      LOG_LEVEL: "verbose",
      BB_WASM_PATH,
      BB_BINARY_PATH,
      BB_NAPI_PATH,
      NATIVE_HOST_PATH,
      CHROME_EXTENSION_ID,
    }),
  },
});
