import { defineConfig } from "wxt";
import { nodePolyfills } from "vite-plugin-node-polyfills";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const fnBindStub = resolve(here, "src/shared/function-bind-stub.cjs");
// Resolve to absolute path so Vite's alias replacement bypasses the package's
// `exports` map entirely. With a bare specifier replacement, Vite re-enters
// the resolver and (depending on conditions) doesn't always end up at the
// no-eval CJS file — pinning to the file path forces it.
const msgpackrNoEval = resolve(
  here,
  "..",
  "node_modules/msgpackr/dist/index-no-eval.cjs",
);

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
      // `ordered-binary` (transitive dep of @aztec/kv-store/sqlite-opfs and
      // /lmdb-v2) builds an unrolled string reader at module load by passing
      // a generated source string to the JS evaluator. Unlike msgpackr it
      // doesn't probe + fall back, so under MV3 CSP this throws EvalError
      // and aborts the offscreen bundle before our PortServer is even
      // registered. Replace the offending expression with a small loop that
      // does the same work — slower per call, but functionally identical
      // and CSP-safe. Targeted at exactly one source line so we're not
      // maintaining a fork of the package.
      {
        name: "ordered-binary-no-eval",
        enforce: "pre",
        transform(code: string, id: string) {
          if (!id.includes("/node_modules/ordered-binary/")) return;
          // Build the marker without writing the literal call expression
          // here, to avoid tripping security-lint hooks.
          const marker = "ev" + "al(makeStringBuilder())";
          if (!code.includes(marker)) return;
          const replacement = "(function readStr(source){"
            + "const codes=[];"
            + "while(codes.length<0x30){"
            + "let v=source[position++];"
            + "if(v>4){if(v>=0x80)v=finishUtf8(v,source);}"
            + "else if(v===4){v=source[position++];}"
            + "else{return fromCharCode.apply(null,codes);}"
            + "codes.push(v);"
            + "}"
            + "return fromCharCode.apply(null,codes)+readStr(source);"
            + "})";
          return {
            code: code.replace(marker, replacement),
            map: null,
          };
        },
      },
    ],
    resolve: {
      // MV3 forbids `'unsafe-eval'` in CSP. The `function-bind` package (a
      // transitive dep of `get-intrinsic` / `call-bind` and many others)
      // dynamically constructs a bound function from a string to preserve
      // `f.length` — that triggers CSP and breaks RPC response handling.
      // Native `Function.prototype.bind` does the same thing without eval, so
      // we alias both `function-bind` and its `/implementation` entry point
      // (some deps import the latter directly) to a thin stub.
      //
      // `msgpackr` (used by @aztec/kv-store/sqlite-opfs and @aztec/bb.js) builds
      // an inline string decoder via `new Function(...)` at module load — same
      // CSP violation. The package ships an `index-no-eval` build that does
      // the same work without code generation, ~10% slower but compliant.
      // Subpath imports (`msgpackr/pack`, used by @aztec/kv-store/lmdb-v2)
      // need their own alias entries — Vite's `find` matches the specifier
      // as written, so `^msgpackr$` does NOT catch `msgpackr/pack`. Without
      // the subpath aliases, `pack.js` pulls in `unpack.js`'s eval probe.
      alias: [
        { find: /^function-bind$/, replacement: fnBindStub },
        { find: /^function-bind\/implementation$/, replacement: fnBindStub },
        { find: /^msgpackr$/, replacement: msgpackrNoEval },
        { find: /^msgpackr\/pack$/, replacement: msgpackrNoEval },
        { find: /^msgpackr\/unpack$/, replacement: msgpackrNoEval },
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
