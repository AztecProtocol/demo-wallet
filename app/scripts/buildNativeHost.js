#!/usr/bin/env node
/**
 * Build script for the native messaging host binary.
 *
 * Uses esbuild to bundle the TypeScript code, then pkg to compile
 * it into a standalone binary for each platform.
 *
 * Usage:
 *   node scripts/buildNativeHost.js        # Build for current platform only
 *   node scripts/buildNativeHost.js --all  # Build for all platforms
 */

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT_DIR = path.resolve(__dirname, "..");
const SRC_DIR = path.join(ROOT_DIR, "src", "native-host");
const DIST_DIR = path.join(ROOT_DIR, "dist", "native-host");
const BUNDLE_PATH = path.join(DIST_DIR, "bundle.cjs");

// Target configurations for pkg
const TARGETS = {
  "darwin-arm64": "node18-macos-arm64",
  "darwin-x64": "node18-macos-x64",
  "linux-x64": "node18-linux-x64",
  "linux-arm64": "node18-linux-arm64",
  "win32-x64": "node18-win-x64",
};

function getCurrentTarget() {
  const platform = process.platform;
  const arch = process.arch;
  return `${platform}-${arch}`;
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function buildBundle() {
  console.log("Bundling native host with esbuild...");

  ensureDir(DIST_DIR);

  // Use esbuild to bundle the TypeScript code
  const entryPoint = path.join(SRC_DIR, "index.ts");

  execSync(
    `npx esbuild "${entryPoint}" --bundle --platform=node --target=node18 --format=cjs --outfile="${BUNDLE_PATH}"`,
    {
      cwd: ROOT_DIR,
      stdio: "inherit",
    }
  );

  console.log(`Bundle created: ${BUNDLE_PATH}`);
}

function buildBinary(target) {
  const pkgTarget = TARGETS[target];
  if (!pkgTarget) {
    console.error(`Unknown target: ${target}`);
    console.error(`Available targets: ${Object.keys(TARGETS).join(", ")}`);
    process.exit(1);
  }

  const outputDir = path.join(DIST_DIR, target);
  ensureDir(outputDir);

  const binaryName = target.startsWith("win32") ? "native-host.exe" : "native-host";
  const outputPath = path.join(outputDir, binaryName);

  console.log(`Building binary for ${target}...`);

  try {
    execSync(
      `npx pkg "${BUNDLE_PATH}" --target ${pkgTarget} --output "${outputPath}"`,
      {
        cwd: ROOT_DIR,
        stdio: "inherit",
      }
    );

    // Make executable on Unix
    if (!target.startsWith("win32")) {
      fs.chmodSync(outputPath, 0o755);
    }

    console.log(`Binary created: ${outputPath}`);
  } catch (err) {
    console.error(`Failed to build binary for ${target}:`, err.message);
    process.exit(1);
  }
}

function main() {
  const args = process.argv.slice(2);
  const buildAll = args.includes("--all");

  // First, bundle the TypeScript code
  buildBundle();

  if (buildAll) {
    // Build for all platforms
    console.log("\nBuilding for all platforms...");
    for (const target of Object.keys(TARGETS)) {
      buildBinary(target);
    }
  } else {
    // Build for current platform only
    const currentTarget = getCurrentTarget();
    if (!TARGETS[currentTarget]) {
      console.error(`Current platform ${currentTarget} is not supported.`);
      console.error(`Supported platforms: ${Object.keys(TARGETS).join(", ")}`);
      process.exit(1);
    }
    buildBinary(currentTarget);
  }

  console.log("\nNative host build complete!");
}

main();
