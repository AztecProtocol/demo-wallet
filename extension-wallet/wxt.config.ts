import { defineConfig } from "wxt";

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  manifest: {
    name: "Aztec Wallet (Extension)",
    description: "Self-contained Aztec wallet — runs the wallet inside the extension",
    permissions: ["storage", "alarms", "offscreen", "webNavigation"],
    host_permissions: ["*://*/*"],
    action: {
      default_popup: "popup/index.html",
      default_title: "Aztec Wallet",
    },
    web_accessible_resources: [
      {
        resources: ["approval/index.html", "expanded/index.html", "onboarding/index.html"],
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
