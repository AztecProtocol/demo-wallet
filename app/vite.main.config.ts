import { defineConfig } from "vite";
import { resolve } from "path";
import { createHash } from "crypto";

const isDev = process.env.NODE_ENV !== "production";

/**
 * Compute Chrome extension ID from the extension directory path.
 * Chrome uses SHA256 of the path, then takes first 32 chars and maps to a-p alphabet.
 * This matches Chrome's algorithm for unpacked extensions.
 */
function computeChromeExtensionId(extensionPath: string): string {
  const hash = createHash("sha256").update(extensionPath).digest("hex");
  // Chrome uses first 32 hex chars, mapped to a-p (0-9a-f -> a-p)
  return hash
    .slice(0, 32)
    .split("")
    .map((c) => String.fromCharCode("a".charCodeAt(0) + parseInt(c, 16)))
    .join("");
}

// In development, compute Chrome extension ID from the extension build directory
// In production, use CHROME_EXTENSION_ID env var (set when publishing to Chrome Web Store)
const CHROME_EXTENSION_ID = isDev
  ? computeChromeExtensionId(
      resolve(__dirname, "../extension/.output/chrome-mv3-dev")
    )
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
const nativeHostBinaryName = platform === "win32" ? "native-host.exe" : "native-host";

const NATIVE_HOST_PATH = isDev
  ? resolve(__dirname, `./dist/native-host/${platform}-${arch}/${nativeHostBinaryName}`)
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
