const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

// Read package.json to get bb.js version
const packageJsonPath = path.join(__dirname, "../package.json");
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
const bbJsVersion = packageJson.dependencies["@aztec/bb.js"];

if (!bbJsVersion) {
  console.error("✗ @aztec/bb.js version not found in package.json");
  process.exit(1);
}

console.log(`Using bb.js version: ${bbJsVersion}`);

// Determine platform and architecture
function getPlatformArch() {
  const platform = process.platform;
  const arch = process.arch;

  // Map Node.js platform to GitHub release naming
  switch (platform) {
    case "darwin":
      // macOS: use format like "arm64-darwin" or "x86_64-darwin"
      if (arch === "arm64") {
        return "arm64-macos";
      } else if (arch === "x64") {
        return "amd64-macos";
      }
      break;
    case "linux":
      // Linux: both amd64-linux and arm64-linux are available
      if (arch === "x64") {
        return "amd64-linux";
      } else if (arch === "arm64") {
        return "arm64-linux";
      }
      console.error(
        `✗ Unsupported Linux architecture: ${arch}. Only x64 and ARM64 are supported.`
      );
      process.exit(1);
    case "win32":
      console.error(`✗ Windows builds are not available for Barretenberg.`);
      process.exit(1);
    default:
      console.error(`✗ Unsupported platform: ${platform}`);
      process.exit(1);
  }

  console.error(
    `✗ Unsupported architecture: ${arch} for platform: ${platform}`
  );
  process.exit(1);
}

// Main function
async function main() {
  // Source paths
  const BB_FOLDER = path.resolve(__dirname, "../node_modules/@aztec/bb.js");

  const BB_WASM_SOURCE = path.join(
    BB_FOLDER,
    "dest/node/barretenberg_wasm/barretenberg-threads.wasm.gz"
  );
  const BB_NAPI_SOURCE = path.join(
    BB_FOLDER,
    `build/${getPlatformArch()}/nodejs_module.node`
  );
  const BB_BINARY_SOURCE = path.join(
    BB_FOLDER,
    `build/${getPlatformArch()}/bb`
  );

  // Destination directory - will be packaged with the app
  const RESOURCES_DIR = path.join(__dirname, "..");
  const BB_DIR = path.join(RESOURCES_DIR, "bb");
  const TEMP_DIR = path.join(BB_DIR, "temp");

  // Create directories if they don't exist
  if (!fs.existsSync(BB_DIR)) {
    fs.mkdirSync(BB_DIR, { recursive: true });
  }
  if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
  }

  // Copy WASM file
  const wasmDest = path.join(BB_DIR, "barretenberg-threads.wasm.gz");
  console.log(`Copying WASM from ${BB_WASM_SOURCE} to ${wasmDest}`);
  if (fs.existsSync(BB_WASM_SOURCE)) {
    fs.copyFileSync(BB_WASM_SOURCE, wasmDest);
    console.log("✓ WASM file copied successfully");
  } else {
    console.error(`✗ WASM file not found at ${BB_WASM_SOURCE}`);
    process.exit(1);
  }

  // Copy N-API module
  const napiDest = path.join(BB_DIR, "nodejs_module.node");
  console.log(`Copying N-API module from ${BB_NAPI_SOURCE} to ${napiDest}`);
  if (fs.existsSync(BB_NAPI_SOURCE)) {
    fs.copyFileSync(BB_NAPI_SOURCE, napiDest);
    console.log("✓ N-API module copied successfully");
  } else {
    console.error(`✗ N-API module not found at ${BB_NAPI_SOURCE}`);
    process.exit(1);
  }

  // Copy BB binary
  const binaryDest = path.join(BB_DIR, "bb");
  console.log(`Copying BB binary from ${BB_BINARY_SOURCE} to ${binaryDest}`);
  if (fs.existsSync(BB_BINARY_SOURCE)) {
    fs.copyFileSync(BB_BINARY_SOURCE, binaryDest);
    // Make binary executable
    fs.chmodSync(binaryDest, 0o755);

    // Remove macOS quarantine attribute (prevents Gatekeeper from killing the binary)
    if (process.platform === "darwin") {
      try {
        execSync(`xattr -d com.apple.quarantine "${binaryDest}"`, {
          stdio: "ignore",
        });
        console.log("✓ Removed quarantine attribute from BB binary");
      } catch {
        // Attribute may not exist, that's fine
      }
    }

    console.log("✓ BB binary installed successfully");
  } else {
    console.error(`✗ BB binary not found after extraction at ${binaryDest}`);
    process.exit(1);
  }
}

main();
