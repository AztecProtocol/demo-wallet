import { defineConfig } from "wxt";
import { nodePolyfills } from "vite-plugin-node-polyfills";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const fnBindStub = resolve(here, "src/shared/function-bind-stub.cjs");

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  vite: () => ({
    // Aztec deps (`@aztec/foundation`, `@aztec/bb.js`, etc.) reach for Node
    // globals — `Buffer`, `process.env.*`, sometimes `global` — at module-init
    // time. The SW and offscreen contexts have none of these. `nodePolyfills`
    // injects globalThis bindings into every chunk via @rollup/plugin-inject,
    // which survives code-splitting (a runtime shim in a single entry does not).
    plugins: [
      nodePolyfills({
        include: ["buffer", "process"],
        globals: { Buffer: true, process: true, global: false },
        protocolImports: false,
      }),
    ],
    resolve: {
      // MV3 forbids `'unsafe-eval'` in CSP. The `function-bind` package (a
      // transitive dep of `get-intrinsic` / `call-bind` and many others)
      // dynamically constructs a bound function from a string to preserve
      // `f.length` — that triggers CSP and breaks RPC response handling.
      // Native `Function.prototype.bind` does the same thing without eval, so
      // we alias both `function-bind` and its `/implementation` entry point
      // (some deps import the latter directly) to a thin stub.
      alias: [
        { find: /^function-bind$/, replacement: fnBindStub },
        { find: /^function-bind\/implementation$/, replacement: fnBindStub },
      ],
    },
    define: {
      // Belt and braces: `process.env.X` references are still substituted at
      // build time so dead-code elimination can strip dev branches even though
      // the polyfill provides a `process` object at runtime.
      "process.env.NODE_ENV": JSON.stringify("production"),
    },
  }),
  manifest: {
    name: "Aztec Wallet (Extension)",
    description: "Self-contained Aztec wallet — runs the wallet inside the extension",
    permissions: ["storage", "alarms", "offscreen", "webNavigation"],
    host_permissions: ["*://*/*"],
    // MV3 only permits `'wasm-unsafe-eval'` here — `'unsafe-eval'` is
    // rejected outright. We rely on the Vite alias above to neutralise the
    // one transitive dep (`function-bind`) that needed it.
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';",
    },
    action: {
      default_popup: "popup.html",
      default_title: "Aztec Wallet",
    },
    web_accessible_resources: [
      {
        resources: ["approval.html", "expanded.html", "onboarding.html"],
        matches: ["<all_urls>"],
      },
    ],
    // Chrome extension key for stable extension ID.
    // Generated with: openssl genrsa 2048 | openssl rsa -pubout -outform DER | base64 | tr -d '\n'
    key: "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAi37s/BnZg6PsFPMfUrSFYqGDmkWogQP1koulIpesrpYyaoOUv8s9dJFAK6HyRT+2HrbAGcZxuxqHpvURd0jf1ETr50tRGUtz65+SEom9QFXQJ1iJflyOwlcuYCmEzN7HNHX2egKgE+33dHZ0mXql8XiaA3b+hugRjn9w+cJXoDuhdtMTChncq8O5AqspSNxSPQIeveB8cOsaAFZJZRmB8jD8EV9x88TjQY9+X1o8/yLSN7NoTWGVTdm3MHXWDdZu6ffUkZtOLHmT++L655VnkG48PqSnvv0DLKK3koOBaKIjfFPrXrhZyUuFBcpOi8jsDfEB9jWZV/Zvant4l0P75QIDAQAB",
    // Firefox requires explicit extension ID.
    browser_specific_settings: {
      gecko: {
        id: "aztec-extension-wallet@aztec.network",
      },
    },
  },
});
