// Placeholder background entrypoint. The full service worker (router) will be
// implemented in a subsequent task. WXT requires at least one entrypoint to
// pass `wxt prepare`, so this file exists primarily to satisfy that check.
export default defineBackground(() => {
  console.log("extension-wallet background worker started");
});
