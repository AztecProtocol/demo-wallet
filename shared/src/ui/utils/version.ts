// `__AZTEC_SDK_VERSION__` is injected at build time via Vite `define` (see web/vite.config.ts and
// app/vite.renderer.config.ts), read from the workspace's pinned `@aztec/aztec.js` dependency so it
// always reflects the SDK the wallet was built against. It is undefined in contexts where that define
// isn't applied (e.g. unit tests), where we fall back to "unknown".
declare const __AZTEC_SDK_VERSION__: string | undefined;

export const AZTEC_SDK_VERSION: string =
  typeof __AZTEC_SDK_VERSION__ !== "undefined" ? __AZTEC_SDK_VERSION__ : "unknown";
