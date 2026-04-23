#!/usr/bin/env node

/**
 * Update demo-wallet to a given Aztec nightly version across the whole monorepo.
 *
 * Scope:
 *   - every workspace package.json (app/, shared/, web/, extension/)
 *   - rollup version for every non-local network in shared/src/config/networks.ts
 *     (any entry with chainId !== 31337 and a nodeUrl gets its version refreshed
 *     from the network's node_getNodeInfo)
 *
 * Usage:
 *   node scripts/update.js [--version VERSION] [--skip-install] [--skip-aztec-up]
 */

import { readFileSync, writeFileSync, statSync } from "fs";
import { resolve, dirname, relative } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const WORKSPACE_DIRS = ["app", "shared", "web", "extension"];

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

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function findWorkspacePackageJsons() {
  const results = [];
  for (const dir of WORKSPACE_DIRS) {
    const pkgPath = resolve(ROOT, dir, "package.json");
    if (isFile(pkgPath)) results.push(pkgPath);
  }
  return results;
}

async function fetchLatestNightly() {
  log(COLORS.yellow, "Fetching latest nightly from npm...");
  try {
    const output = exec("npm view @aztec/aztec.js versions --json", { silent: true });
    const versions = JSON.parse(output);
    const nightlies = versions.filter((v) => v.match(/^4\.\d+\.\d+-nightly\.\d+$/));
    const latest = nightlies[nightlies.length - 1];
    if (!latest) throw new Error("No nightly versions found");
    return latest;
  } catch {
    log(COLORS.red, "Failed to fetch latest nightly version from npm");
    log(COLORS.red, "Please specify a version with --version");
    process.exit(1);
  }
}

const NETWORKS_FILE = resolve(ROOT, "shared/src/config/networks.ts");
const LOCAL_CHAIN_ID = 31337;

/**
 * Minimally parses networks.ts by walking each NETWORKS entry and pulling the
 * id / chainId / nodeUrl fields out of its body. Avoids importing the TS module
 * so the script can run without a build step.
 */
function parseNetworks() {
  const content = readFileSync(NETWORKS_FILE, "utf-8");
  const entries = [];
  const entryRegex = /\{([^{}]*)\}/g;
  let match;
  while ((match = entryRegex.exec(content)) !== null) {
    const body = match[1];
    const id = body.match(/id:\s*"([^"]+)"/)?.[1];
    const chainId = body.match(/chainId:\s*(\d+)/)?.[1];
    const nodeUrl = body.match(/nodeUrl:\s*"([^"]+)"/)?.[1];
    if (!id || !chainId) continue;
    entries.push({ id, chainId: Number(chainId), nodeUrl });
  }
  return entries;
}

async function fetchRollupVersion(nodeUrl) {
  log(COLORS.yellow, `Fetching rollup version from ${nodeUrl}...`);
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
  if (!version) throw new Error("rollupVersion not found in response");
  log(COLORS.green, `Fetched rollup version: ${version}`);
  return String(version);
}

function updatePackageJsonFiles(version) {
  log(COLORS.yellow, "[1/4] Updating workspace package.json files...");

  const packageJsons = findWorkspacePackageJsons();
  let changed = 0;

  for (const path of packageJsons) {
    const original = readFileSync(path, "utf-8");
    const updated = original.replace(/"(@aztec\/[^"]+)": "v[^"]+"/g, `"$1": "v${version}"`);
    if (updated !== original) {
      writeFileSync(path, updated, "utf-8");
      log(COLORS.green, `  ✓ ${relative(ROOT, path)}`);
      changed++;
    }
  }

  log(COLORS.green, `✓ Updated ${changed} package.json file(s)\n`);
}

function installDependencies() {
  log(COLORS.yellow, "[2/4] Running yarn install...");
  exec("yarn install");
  log(COLORS.green, "✓ Dependencies installed\n");
}

function setRollupVersionInFile(networkId, rollupVersion) {
  let content = readFileSync(NETWORKS_FILE, "utf-8");
  const lines = content.split("\n");
  let inBlock = false;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(`id: "${networkId}"`)) {
      inBlock = true;
      continue;
    }
    if (inBlock && lines[i].match(/version:\s*\d+/)) {
      lines[i] = lines[i].replace(/version:\s*\d+/, `version: ${rollupVersion}`);
      break;
    }
  }
  writeFileSync(NETWORKS_FILE, lines.join("\n"), "utf-8");
}

async function updateRollupVersions() {
  log(COLORS.yellow, "[3/4] Updating rollup versions for non-local networks...");

  const networks = parseNetworks().filter(
    (n) => n.chainId !== LOCAL_CHAIN_ID && n.nodeUrl,
  );

  if (networks.length === 0) {
    log(COLORS.yellow, "  (no remote networks found — nothing to update)\n");
    return;
  }

  for (const net of networks) {
    try {
      const rollupVersion = await fetchRollupVersion(net.nodeUrl);
      setRollupVersionInFile(net.id, rollupVersion);
      log(COLORS.green, `  ✓ ${net.id} → ${rollupVersion}`);
    } catch (error) {
      log(COLORS.red, `  ✗ ${net.id}: ${error.message}`);
    }
  }
  console.log();
}

function installAztecCLI(version) {
  log(COLORS.yellow, `[4/4] Installing Aztec CLI version ${version}...`);

  try {
    const current = exec("aztec --version", { silent: true }).trim();
    if (current === version) {
      log(COLORS.green, `✓ Aztec CLI already at v${version}, skipping\n`);
      return;
    }
  } catch {
    // not installed yet — proceed
  }

  try {
    exec("command -v aztec-up", { silent: true });
    exec(`aztec-up install ${version}`);
    log(COLORS.green, "✓ Aztec CLI updated\n");
  } catch {
    log(
      COLORS.red,
      `Warning: aztec-up not found in PATH. Install manually: aztec-up install ${version}\n`,
    );
  }
}

function parseArgs() {
  const args = process.argv.slice(2);
  let version = null;
  let skipInstall = false;
  let skipAztecUp = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--version" && args[i + 1]) {
      version = args[++i].replace(/^v/, "");
    } else if (a === "--skip-install") {
      skipInstall = true;
    } else if (a === "--skip-aztec-up") {
      skipAztecUp = true;
    } else if (a === "--help" || a === "-h") {
      console.log("Usage: node scripts/update.js [OPTIONS]");
      console.log("\nOptions:");
      console.log("  --version VERSION    Nightly version (e.g., 4.3.0-nightly.20260423)");
      console.log("  --skip-install       Skip running yarn install");
      console.log("  --skip-aztec-up      Skip Aztec CLI installation");
      console.log("  --help, -h           Show this help message");
      process.exit(0);
    }
  }

  return { version, skipInstall, skipAztecUp };
}

async function main() {
  log(COLORS.green, "=== Demo Wallet Nightly Update Script ===\n");

  let { version, skipInstall, skipAztecUp } = parseArgs();

  if (!version) {
    version = await fetchLatestNightly();
    log(COLORS.green, `Latest nightly version: v${version}\n`);
  } else {
    log(COLORS.green, `Updating to version: v${version}\n`);
  }

  updatePackageJsonFiles(version);

  if (skipInstall) {
    log(COLORS.yellow, "[2/4] Skipping yarn install (--skip-install)\n");
  } else {
    installDependencies();
  }

  await updateRollupVersions();

  if (skipAztecUp) {
    log(COLORS.yellow, "[4/4] Skipping Aztec CLI installation (--skip-aztec-up)\n");
  } else {
    installAztecCLI(version);
  }

  log(COLORS.green, "=== Update Complete ===");
  log(COLORS.green, `Version: v${version}`);
}

main().catch((error) => {
  log(COLORS.red, `Error: ${error.message}`);
  process.exit(1);
});
