#!/usr/bin/env node

/**
 * Update demo-wallet to the latest Aztec nightly version.
 *
 * Usage:
 *   node scripts/update.js [--version VERSION] [--rollup-version VERSION] [--network ID]
 */

import { readFileSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// Color codes
const COLORS = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
};

function log(color, message) {
  console.log(`${color}${message}${COLORS.reset}`);
}

function exec(command, options = {}) {
  return execSync(command, {
    cwd: options.cwd || ROOT,
    stdio: options.silent ? "pipe" : "inherit",
    encoding: "utf-8",
    ...options,
  });
}

async function fetchLatestNightly() {
  log(COLORS.yellow, "Fetching latest nightly from npm...");
  try {
    const output = exec("npm view @aztec/aztec.js versions --json", {
      silent: true,
    });
    const versions = JSON.parse(output);
    const nightlies = versions.filter((v) => v.match(/^4\.0\.0-nightly\.\d+$/));
    const latest = nightlies[nightlies.length - 1];
    if (!latest) {
      throw new Error("No nightly versions found");
    }
    return latest;
  } catch (error) {
    log(COLORS.red, "Failed to fetch latest nightly version from npm");
    log(COLORS.red, "Please specify a version with --version");
    process.exit(1);
  }
}

function getNodeUrlFromConfig(networkId) {
  const networksFile = resolve(ROOT, "shared/src/config/networks.ts");
  const content = readFileSync(networksFile, "utf-8");

  const lines = content.split("\n");
  let inBlock = false;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(`id: "${networkId}"`)) {
      inBlock = true;
    }
    if (inBlock) {
      const match = lines[i].match(/nodeUrl:\s*"([^"]+)"/);
      if (match) {
        return match[1];
      }
    }
  }
  throw new Error(`No nodeUrl found for network "${networkId}" in networks.ts`);
}

async function fetchRollupVersion(nodeUrl) {
  log(COLORS.yellow, `Fetching rollup version from ${nodeUrl}...`);
  try {
    const res = await fetch(nodeUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "node_getNodeInfo",
        params: [],
      }),
    });
    const json = await res.json();
    const version = json.result?.rollupVersion;
    if (!version) {
      throw new Error("rollupVersion not found in response");
    }
    log(COLORS.green, `Fetched rollup version: ${version}`);
    return String(version);
  } catch (error) {
    throw new Error(`Failed to fetch rollup version from ${nodeUrl}: ${error.message}`);
  }
}

function updatePackageJson(path, version) {
  let content = readFileSync(path, "utf-8");
  content = content.replace(/"(@aztec\/[^"]+)": "v[^"]+"/g, `"$1": "v${version}"`);
  writeFileSync(path, content, "utf-8");
}

function updateAppPackageJson(version) {
  log(COLORS.yellow, "[1/5] Updating app/package.json...");
  updatePackageJson(resolve(ROOT, "app/package.json"), version);
  log(COLORS.green, "✓ app/package.json updated\n");
}

function updateSharedPackageJson(version) {
  log(COLORS.yellow, "[2/5] Updating shared/package.json...");
  updatePackageJson(resolve(ROOT, "shared/package.json"), version);
  log(COLORS.green, "✓ shared/package.json updated\n");
}

function updateExtensionPackageJson(version) {
  log(COLORS.yellow, "[3/5] Updating extension/package.json...");
  updatePackageJson(resolve(ROOT, "extension/package.json"), version);
  log(COLORS.green, "✓ extension/package.json updated\n");
}

function installDependencies() {
  log(COLORS.yellow, "[4/5] Running yarn install from root...");
  exec("yarn install", { cwd: ROOT });
  log(COLORS.green, "✓ Dependencies installed\n");
}

function updateRollupVersion(networkId, rollupVersion) {
  log(COLORS.yellow, `[5/5] Updating ${networkId} rollup version to ${rollupVersion}...`);
  const networksFile = resolve(ROOT, "shared/src/config/networks.ts");
  let content = readFileSync(networksFile, "utf-8");

  // Find the network config and update its version
  const lines = content.split("\n");
  let inBlock = false;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(`id: "${networkId}"`)) {
      inBlock = true;
    }
    if (inBlock && lines[i].match(/version:\s*\d+/)) {
      lines[i] = lines[i].replace(/version:\s*\d+/, `version: ${rollupVersion}`);
      break;
    }
  }

  writeFileSync(networksFile, lines.join("\n"), "utf-8");
  log(COLORS.green, `✓ Rollup version updated for ${networkId} in networks.ts\n`);
}

async function main() {
  log(COLORS.green, "=== Demo Wallet Nightly Update Script ===\n");

  // Parse arguments
  const args = process.argv.slice(2);
  let version = null;
  let rollupVersion = null;
  let network = "nextnet";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--version" && args[i + 1]) {
      version = args[i + 1].replace(/^v/, "");
      i++;
    } else if (args[i] === "--rollup-version" && args[i + 1]) {
      rollupVersion = args[i + 1];
      i++;
    } else if (args[i] === "--network" && args[i + 1]) {
      network = args[i + 1];
      i++;
    } else if (args[i] === "--help") {
      console.log("Usage: node scripts/update-to-nightly.js [OPTIONS]");
      console.log("\nOptions:");
      console.log(
        "  --version VERSION              Specify nightly version (e.g., 4.0.0-nightly.20260206)",
      );
      console.log("  --rollup-version VERSION       Specify rollup version manually");
      console.log(
        "  --network ID                   Network ID to update in networks.ts (default: nextnet)",
      );
      console.log("  --help                         Show this help message");
      process.exit(0);
    }
  }

  // Fetch latest if not specified
  if (!version) {
    version = await fetchLatestNightly();
    log(COLORS.green, `Latest nightly version: v${version}\n`);
  } else {
    log(COLORS.green, `Updating to version: v${version}\n`);
  }

  // Fetch rollup version if not specified
  if (!rollupVersion) {
    const nodeUrl = getNodeUrlFromConfig(network);
    rollupVersion = await fetchRollupVersion(nodeUrl);
  }

  // Run update steps
  updateAppPackageJson(version);
  updateSharedPackageJson(version);
  updateExtensionPackageJson(version);
  installDependencies();
  updateRollupVersion(network, rollupVersion);

  log(COLORS.green, "=== Update Complete ===");
  log(COLORS.green, `Version: v${version}`);
  if (rollupVersion) {
    log(COLORS.green, `Rollup version: ${rollupVersion} (${network})`);
  }
}

main().catch((error) => {
  log(COLORS.red, `Error: ${error.message}`);
  process.exit(1);
});
