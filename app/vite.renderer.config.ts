import { defineConfig, type Plugin } from "vite";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react-swc";
import { PolyfillOptions, nodePolyfills } from "vite-plugin-node-polyfills";

const nodePolyfillsFix = (options?: PolyfillOptions | undefined): Plugin => {
  return {
    ...nodePolyfills(options),
    // @ts-expect-error - resolveId signature mismatch with vite-plugin-node-polyfills spread type
    resolveId(source: string) {
      const m = /^vite-plugin-node-polyfills\/shims\/(buffer|global|process)$/.exec(source);
      if (m) {
        return `./node_modules/vite-plugin-node-polyfills/shims/${m[1]}/dist/index.cjs`;
      }
    },
  };
};

// https://vitejs.dev/config
export default defineConfig({
  server: {
    port: 5174,
  },
  resolve: {
    // Resolve @demo-wallet/shared/* directly to the source files, bypassing
    // the node_modules symlink. This ensures Vite treats them as part of the
    // app bundle (applying the SWC/JSX transform) rather than as externals
    // served raw via /@fs/node_modules/.
    alias: {
      "@demo-wallet/shared/ui": resolve(import.meta.dirname, "../shared/src/ui.ts"),
      "@demo-wallet/shared/core": resolve(import.meta.dirname, "../shared/src/core.ts"),
    },
  },
  plugins: [
    react({ jsxImportSource: "@emotion/react" }),
    nodePolyfillsFix({ include: ["buffer", "path"] }),
  ],
});
