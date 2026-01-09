import { defineConfig } from "wxt";

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  manifest: {
    permissions: ["nativeMessaging"],
    // Firefox requires explicit extension ID for native messaging
    browser_specific_settings: {
      gecko: {
        id: "aztec-keychain@aztec.network",
      },
    },
  },
});
