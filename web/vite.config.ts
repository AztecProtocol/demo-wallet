import { defineConfig, Plugin, searchForWorkspaceRoot } from "vite";
import react from "@vitejs/plugin-react";
import { PolyfillOptions, nodePolyfills } from "vite-plugin-node-polyfills";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { readFileSync } from "fs";
import { createRequire } from "module";

// Resolve the actual location of vite-plugin-node-polyfills (may be hoisted in workspaces)
const polyfillsPkgPath = resolve(
  dirname(fileURLToPath(import.meta.resolve("vite-plugin-node-polyfills"))),
  "..",
);

// Workaround for https://github.com/davidmyersdev/vite-plugin-node-polyfills/issues/81
const nodePolyfillsFix = (options?: PolyfillOptions): Plugin => {
  return {
    ...nodePolyfills(options),
    // @ts-expect-error - resolveId signature mismatch with vite-plugin-node-polyfills spread type
    resolveId(source: string) {
      const m = /^vite-plugin-node-polyfills\/shims\/(buffer|global|process)$/.exec(source);
      if (m) {
        return resolve(polyfillsPkgPath, `shims/${m[1]}/dist/index.cjs`);
      }
    },
  };
};

// Emits @aztec/sqlite3mc-wasm's runtime-loaded files into assets/ under their
// ORIGINAL names. Since SQLite3MultipleCiphers 2.3.5 (aztec-packages#24293)
// the sqlite3mc loader resolves sqlite3.wasm through Module['locateFile'] with
// a *dynamic* path the bundler can't rewrite, so production builds request an
// unhashed assets/sqlite3.wasm relative to the worker chunk and 404
// ("unsupported MIME type" follow-up). Dev servers are unaffected. The OPFS
// async-proxy script is resolved the same runtime-relative way.
const sqliteRuntimeAssetsPlugin = (): Plugin => {
  const RUNTIME_FILES = ["sqlite3.wasm", "sqlite3-opfs-async-proxy.js"];
  return {
    name: "aztec-sqlite-runtime-assets",
    apply: "build",
    generateBundle() {
      const require = createRequire(`${process.cwd()}/package.json`);
      for (const file of RUNTIME_FILES) {
        let resolved: string;
        try {
          resolved = require.resolve(`@aztec/sqlite3mc-wasm/vendor/jswasm/${file}`);
        } catch {
          return; // package not installed
        }
        this.emitFile({
          type: "asset",
          fileName: `assets/${file}`,
          source: readFileSync(resolved),
        });
      }
    },
  };
};

export default defineConfig({
  server: {
    port: 3001,
    // Required for WASM multithreading (SharedArrayBuffer)
    // CORP: cross-origin allows this page to be embedded as a cross-origin iframe by dApps
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cross-Origin-Resource-Policy": "cross-origin",
    },
    fs: {
      allow: [searchForWorkspaceRoot(import.meta.dirname)],
    },
  },
  plugins: [
    react({ jsxImportSource: "@emotion/react" }),
    nodePolyfillsFix({ include: ["buffer", "path"] }),
    sqliteRuntimeAssetsPlugin(),
  ],
  define: {
    "process.env": JSON.stringify({
      LOG_LEVEL: process.env.LOG_LEVEL,
    }),
  },
});
