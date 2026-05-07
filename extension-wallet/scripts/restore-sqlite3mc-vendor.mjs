#!/usr/bin/env node
/**
 * Workaround for a packaging gap in @aztec/sqlite3mc-wasm: the published npm
 * tarball ships only a SHA256SUMS manifest and the locally-authored .d.mts
 * declaration; the actual sqlite3mc WASM/MJS artifacts are gitignored upstream
 * and don't make it into the published bundle. Without them the package's own
 * `dest/index.js` fails to resolve `'../vendor/jswasm/sqlite3-bundler-friendly.mjs'`
 * at bundle time.
 *
 * Until the upstream packaging bug is fixed we keep a verified copy of the
 * binaries at extension-wallet/vendor/sqlite3mc-wasm/jswasm/ (sourced from
 * sqlite3mc v2.2.4 + sqlite 3.50.4 — the version pinned by aztec-packages
 * yarn-project/sqlite3mc-wasm/scripts/vendor.pin at the
 * v4.3.0-nightly.20260506 tag) and copy them into node_modules after install.
 *
 * On every run we verify the vendored copies against the SHA256SUMS the
 * package itself ships, which catches both vendored-file corruption and
 * upstream manifest drift in future dep bumps. If hashes don't match, abort
 * loudly — better to fail-fast than to silently ship mismatched binaries.
 *
 * To remove this workaround: delete the vendor/sqlite3mc-wasm/ tree, this
 * script, and the postinstall entry in extension-wallet/package.json.
 */

import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_VENDOR_DIR = join(HERE, "..", "vendor", "sqlite3mc-wasm", "jswasm");
const NM_PKG_DIR = join(HERE, "..", "..", "node_modules", "@aztec", "sqlite3mc-wasm");
const NM_VENDOR_DIR = join(NM_PKG_DIR, "vendor", "jswasm");
const SHA256SUMS_PATH = join(NM_VENDOR_DIR, "SHA256SUMS");

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  if (!(await exists(NM_PKG_DIR))) {
    // Package isn't installed (e.g. running script before yarn install).
    // Silent no-op so this script is safe to run unconditionally.
    return;
  }

  const sumsRaw = await readFile(SHA256SUMS_PATH, "utf8");
  const expected = new Map();
  for (const line of sumsRaw.split("\n")) {
    const m = line.match(/^([0-9a-f]{64})\s+(\S+)$/);
    if (m) expected.set(m[2], m[1]);
  }

  // Files we restore are everything in SHA256SUMS except the locally-authored
  // .d.mts which the package already ships.
  const RESTORE_FILES = [...expected.keys()].filter((f) => f !== "sqlite3-bundler-friendly.d.mts");

  await mkdir(NM_VENDOR_DIR, { recursive: true });

  let restored = 0;
  for (const file of RESTORE_FILES) {
    const src = join(REPO_VENDOR_DIR, file);
    if (!(await exists(src))) {
      throw new Error(
        `[restore-sqlite3mc-vendor] missing vendored file: ${src}\n` +
          `  Expected to find a verified copy in extension-wallet/vendor/sqlite3mc-wasm/jswasm/`,
      );
    }
    const buf = await readFile(src);
    const actualHash = createHash("sha256").update(buf).digest("hex");
    const expectedHash = expected.get(file);
    if (actualHash !== expectedHash) {
      throw new Error(
        `[restore-sqlite3mc-vendor] SHA256 mismatch for ${file}\n` +
          `  vendored: ${actualHash}\n` +
          `  expected: ${expectedHash}\n` +
          `  Either the vendored copy is corrupt or upstream re-released. Investigate before proceeding.`,
      );
    }
    await writeFile(join(NM_VENDOR_DIR, file), buf);
    restored += 1;
  }
  console.log(`[restore-sqlite3mc-vendor] restored ${restored} files into ${NM_VENDOR_DIR}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
