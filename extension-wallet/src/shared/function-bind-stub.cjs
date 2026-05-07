// CSP-safe replacement for the `function-bind` npm package and its
// `/implementation` entry point. The original constructs a bound function from
// a dynamic string to preserve `f.length`, which Manifest V3's CSP rejects.
// Native `Function.prototype.bind` does the same thing in modern engines
// without dynamic code construction.
//
// This file is intentionally CommonJS (.cjs) because consumers of
// `function-bind` rely on `module.exports = fn` — i.e. the module *itself* is
// the bind function. ESM `export default` would resolve to `{ default: fn }`
// under CJS interop and crash callers that do `bind.apply(...)`.
//
// Wired in via `resolve.alias` in `wxt.config.ts`.

"use strict";

var nativeBind = Function.prototype.bind;

function bind(that) {
  return nativeBind.apply(this, arguments);
}

module.exports = bind;
