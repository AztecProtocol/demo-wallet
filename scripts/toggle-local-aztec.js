#!/usr/bin/env node

/**
 * Toggle local aztec-packages resolutions in package.json files.
 *
 * Usage:
 *   node scripts/toggle-local-aztec.js enable /path/to/aztec-packages
 *   node scripts/toggle-local-aztec.js disable
 *   node scripts/toggle-local-aztec.js status
 */

import { readFileSync, writeFileSync, existsSync, rmSync, readdirSync, statSync, lstatSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// Package.json files to modify (relative to repo root)
const PACKAGE_FILES = ["app/package.json", "extension/package.json"];

// Directories containing package.json files (for yarn install)
const PACKAGE_DIRS = ["app", "extension"];

// Mapping of @aztec/* packages to their paths within aztec-packages
const PACKAGE_MAPPINGS = {
  "@aztec/accounts": "yarn-project/accounts",
  "@aztec/archiver": "yarn-project/archiver",
  "@aztec/aztec.js": "yarn-project/aztec.js",
  "@aztec/bb.js": "barretenberg/ts",
  "@aztec/bb-prover": "yarn-project/bb-prover",
  "@aztec/blob-client": "yarn-project/blob-client",
  "@aztec/blob-lib": "yarn-project/blob-lib",
  "@aztec/blob-sink": "yarn-project/blob-sink",
  "@aztec/builder": "yarn-project/builder",
  "@aztec/constants": "yarn-project/constants",
  "@aztec/entrypoints": "yarn-project/entrypoints",
  "@aztec/epoch-cache": "yarn-project/epoch-cache",
  "@aztec/ethereum": "yarn-project/ethereum",
  "@aztec/foundation": "yarn-project/foundation",
  "@aztec/key-store": "yarn-project/key-store",
  "@aztec/kv-store": "yarn-project/kv-store",
  "@aztec/l1-artifacts": "yarn-project/l1-artifacts",
  "@aztec/merkle-tree": "yarn-project/merkle-tree",
  "@aztec/native": "yarn-project/native",
  "@aztec/noir-acvm_js": "noir/packages/acvm_js",
  "@aztec/noir-contracts.js": "yarn-project/noir-contracts.js",
  "@aztec/noir-noir_codegen": "noir/packages/noir_codegen",
  "@aztec/noir-noirc_abi": "noir/packages/noirc_abi",
  "@aztec/noir-protocol-circuits-types":
    "yarn-project/noir-protocol-circuits-types",
  "@aztec/noir-types": "noir/packages/types",
  "@aztec/node-keystore": "yarn-project/node-keystore",
  "@aztec/node-lib": "yarn-project/node-lib",
  "@aztec/p2p": "yarn-project/p2p",
  "@aztec/protocol-contracts": "yarn-project/protocol-contracts",
  "@aztec/prover-client": "yarn-project/prover-client",
  "@aztec/pxe": "yarn-project/pxe",
  "@aztec/sequencer-client": "yarn-project/sequencer-client",
  "@aztec/simulator": "yarn-project/simulator",
  "@aztec/slasher": "yarn-project/slasher",
  "@aztec/stdlib": "yarn-project/stdlib",
  "@aztec/telemetry-client": "yarn-project/telemetry-client",
  "@aztec/test-wallet": "yarn-project/test-wallet",
  "@aztec/validator-client": "yarn-project/validator-client",
  "@aztec/wallet-sdk": "yarn-project/wallet-sdk",
  "@aztec/world-state": "yarn-project/world-state",
};

function readPackageJson(filePath) {
  const fullPath = resolve(ROOT, filePath);
  if (!existsSync(fullPath)) {
    return null;
  }
  return JSON.parse(readFileSync(fullPath, "utf-8"));
}

function writePackageJson(filePath, data) {
  const fullPath = resolve(ROOT, filePath);
  writeFileSync(fullPath, JSON.stringify(data, null, 2) + "\n");
}

function generateResolutions(aztecPath) {
  const resolutions = {};
  for (const [pkg, subPath] of Object.entries(PACKAGE_MAPPINGS)) {
    resolutions[pkg] = `link:${aztecPath}/${subPath}`;
  }
  return resolutions;
}

function setupGitHooks() {
  const hooksPath = resolve(ROOT, ".githooks");
  if (!existsSync(hooksPath)) {
    console.log("Warning: .githooks directory not found, skipping hook setup");
    return;
  }

  try {
    execSync("git config core.hooksPath .githooks", {
      cwd: ROOT,
      stdio: "pipe",
    });
    console.log("Configured git hooks to use .githooks directory");
  } catch (error) {
    console.log("Warning: Failed to configure git hooks:", error.message);
  }
}

/**
 * Recursively finds and removes broken @aztec symlinks in node_modules.
 * This fixes issues where Yarn leaves stale portal symlinks when switching
 * between local and npm resolutions.
 */
function cleanupBrokenAztecSymlinks(dir) {
  const nodeModulesPath = resolve(dir, "node_modules");
  if (!existsSync(nodeModulesPath)) {
    return 0;
  }

  let cleaned = 0;

  // Clean @aztec directory in this node_modules
  const aztecPath = resolve(nodeModulesPath, "@aztec");
  if (existsSync(aztecPath)) {
    try {
      const entries = readdirSync(aztecPath);
      for (const entry of entries) {
        const entryPath = resolve(aztecPath, entry);
        const stats = lstatSync(entryPath);

        // Check if it's a symlink
        if (stats.isSymbolicLink()) {
          // Check if the symlink target exists
          try {
            statSync(entryPath); // This follows the symlink
          } catch {
            // Broken symlink - remove it
            console.log(`  Removing broken symlink: ${entryPath}`);
            rmSync(entryPath, { force: true });
            cleaned++;
          }
        } else if (stats.isDirectory()) {
          // Check if directory is essentially empty or only contains node_modules
          const contents = readdirSync(entryPath);
          const hasOnlyNodeModules = contents.length === 0 ||
            (contents.length === 1 && contents[0] === "node_modules");
          if (hasOnlyNodeModules) {
            console.log(`  Removing broken package dir: ${entryPath}`);
            rmSync(entryPath, { recursive: true, force: true });
            cleaned++;
          }
        }
      }

      // Remove @aztec dir if empty
      const remaining = readdirSync(aztecPath);
      if (remaining.length === 0) {
        rmSync(aztecPath, { recursive: true, force: true });
      }
    } catch (err) {
      // Ignore errors reading directories
    }
  }

  // Recursively check nested node_modules in @aztec packages and other deps
  try {
    const entries = readdirSync(nodeModulesPath);
    for (const entry of entries) {
      if (entry === ".bin" || entry === ".cache") continue;

      const entryPath = resolve(nodeModulesPath, entry);
      const stats = lstatSync(entryPath);

      if (stats.isDirectory() && !stats.isSymbolicLink()) {
        if (entry === "@aztec") {
          // Check subdirectories of @aztec
          const aztecEntries = readdirSync(entryPath);
          for (const aztecEntry of aztecEntries) {
            const aztecEntryPath = resolve(entryPath, aztecEntry);
            const aztecStats = lstatSync(aztecEntryPath);
            if (aztecStats.isDirectory() && !aztecStats.isSymbolicLink()) {
              cleaned += cleanupBrokenAztecSymlinks(aztecEntryPath);
            }
          }
        } else if (entry.startsWith("@")) {
          // Scoped package - check subdirectories
          const scopedEntries = readdirSync(entryPath);
          for (const scopedEntry of scopedEntries) {
            const scopedPath = resolve(entryPath, scopedEntry);
            const scopedStats = lstatSync(scopedPath);
            if (scopedStats.isDirectory() && !scopedStats.isSymbolicLink()) {
              cleaned += cleanupBrokenAztecSymlinks(scopedPath);
            }
          }
        } else {
          cleaned += cleanupBrokenAztecSymlinks(entryPath);
        }
      }
    }
  } catch {
    // Ignore errors
  }

  return cleaned;
}

function runYarnInstall() {
  // First, clean up broken symlinks
  console.log("\nCleaning up stale @aztec symlinks...");
  let totalCleaned = 0;
  for (const dir of PACKAGE_DIRS) {
    const fullPath = resolve(ROOT, dir);
    if (!existsSync(fullPath)) {
      continue;
    }
    const cleaned = cleanupBrokenAztecSymlinks(fullPath);
    totalCleaned += cleaned;
  }
  if (totalCleaned > 0) {
    console.log(`  Cleaned ${totalCleaned} broken symlinks/directories`);
  } else {
    console.log("  No broken symlinks found");
  }

  console.log("\nRunning yarn install...");
  for (const dir of PACKAGE_DIRS) {
    const fullPath = resolve(ROOT, dir);
    if (!existsSync(fullPath)) {
      continue;
    }
    console.log(`  Installing dependencies in ${dir}...`);
    try {
      execSync("yarn install", { cwd: fullPath, stdio: "inherit" });
    } catch (error) {
      console.error(`  Failed to install in ${dir}:`, error.message);
    }
  }
}

function enable(aztecPath) {
  if (!aztecPath) {
    console.error("Error: aztec-packages path is required for enable command");
    console.error(
      "Usage: node scripts/toggle-local-aztec.js enable /path/to/aztec-packages"
    );
    process.exit(1);
  }

  const resolvedPath = resolve(aztecPath);
  if (!existsSync(resolvedPath)) {
    console.error(`Error: Path does not exist: ${resolvedPath}`);
    process.exit(1);
  }

  if (!existsSync(resolve(resolvedPath, "yarn-project"))) {
    console.error(
      `Error: Path does not appear to be aztec-packages: ${resolvedPath}`
    );
    process.exit(1);
  }

  const resolutions = generateResolutions(resolvedPath);

  for (const file of PACKAGE_FILES) {
    const pkg = readPackageJson(file);
    if (!pkg) {
      console.log(`Skipping ${file} (not found)`);
      continue;
    }

    pkg.resolutions = resolutions;
    writePackageJson(file, pkg);
    console.log(`Enabled local resolutions in ${file}`);
  }

  // Setup git hooks to prevent accidental commits
  setupGitHooks();

  console.log(`\nLocal aztec-packages resolutions enabled.`);
  console.log(`Path: ${resolvedPath}`);

  // Run yarn install
  runYarnInstall();
}

function disable() {
  for (const file of PACKAGE_FILES) {
    const pkg = readPackageJson(file);
    if (!pkg) {
      console.log(`Skipping ${file} (not found)`);
      continue;
    }

    if (pkg.resolutions) {
      delete pkg.resolutions;
      writePackageJson(file, pkg);
      console.log(`Disabled local resolutions in ${file}`);
    } else {
      console.log(`No resolutions to remove in ${file}`);
    }
  }

  console.log(`\nLocal aztec-packages resolutions disabled.`);

  // Run yarn install
  runYarnInstall();
}

function status() {
  for (const file of PACKAGE_FILES) {
    const pkg = readPackageJson(file);
    if (!pkg) {
      console.log(`${file}: not found`);
      continue;
    }

    if (pkg.resolutions && Object.keys(pkg.resolutions).length > 0) {
      const firstResolution = Object.values(pkg.resolutions)[0];
      const match = firstResolution.match(
        /^link:(.+?)\/(?:yarn-project|barretenberg|noir)/
      );
      const path = match ? match[1] : "unknown";
      console.log(`${file}: ENABLED (${path})`);
    } else {
      console.log(`${file}: disabled`);
    }
  }

  // Check git hooks status
  try {
    const hooksPath = execSync("git config core.hooksPath", {
      cwd: ROOT,
      stdio: "pipe",
    })
      .toString()
      .trim();
    console.log(`git hooks: ${hooksPath || "default"}`);
  } catch {
    console.log("git hooks: default");
  }
}

// Main
const [, , command, aztecPath] = process.argv;

switch (command) {
  case "enable":
    enable(aztecPath);
    break;
  case "disable":
    disable();
    break;
  case "status":
    status();
    break;
  default:
    console.log(
      "Toggle local aztec-packages resolutions in package.json files."
    );
    console.log("");
    console.log("Usage:");
    console.log(
      "  node scripts/toggle-local-aztec.js enable /path/to/aztec-packages"
    );
    console.log("  node scripts/toggle-local-aztec.js disable");
    console.log("  node scripts/toggle-local-aztec.js status");
    process.exit(1);
}
