import { defineConfig } from "wxt";

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  manifest: {
    permissions: ["nativeMessaging", "storage"],
    // Chrome extension key for stable extension ID
    // This gives extension ID: hjhmnnoabfekdjkkfhegoieolcdlmmjc
    // Generated with: openssl genrsa 2048 | openssl rsa -pubout -outform DER | base64
    key: "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAzRCfoJMcAAsoEgVuohCL8OTI9oley3Vxulw3jCkhlXbgJ7PVeB98rlnrVUrwqaPHkQtfQB0hheNFbV1mVyzrRYpI4fBBG4J266z5bHvbjZaAvX7ScMWq9TkSdcXpn+vlxQ2hR+fXcrnlrmhdQoMd/42kE53JGvOTI68j1Y8BSEU5wRn+JlkxIUoBnxbS2/SnOn7uOaDIJNk9FD5cK4aRV3FtMfwLNYRw+9BeN3PoJQ/uTWw7YqNEHBrJ1lgYGr2ACXm7APzB8HPq4pLVgB7OcqSIUiLIKZBY4Kk6fswV6I2U0JBqdWNR0kepS71npIpROISaviL+b33Ym0XyXe2bQwIDAQAB",
    // Firefox requires explicit extension ID for native messaging
    browser_specific_settings: {
      gecko: {
        id: "aztec-keychain@aztec.network",
      },
    },
  },
});
