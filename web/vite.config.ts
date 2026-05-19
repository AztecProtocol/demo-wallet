import { defineConfig, Plugin, searchForWorkspaceRoot } from "vite";
import react from "@vitejs/plugin-react";
import { PolyfillOptions, nodePolyfills } from "vite-plugin-node-polyfills";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

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
  plugins: [react({ jsxImportSource: "@emotion/react" }), nodePolyfillsFix({ include: ["buffer", "path"] })],
  define: {
    "process.env": JSON.stringify({
      LOG_LEVEL: process.env.LOG_LEVEL,
    }),
  },
});
