import { defineConfig } from "vite";

export default defineConfig({
  build: {
    rollupOptions: {
      // This is required due to unfortunate electron-forge weirdness
      external: ["@aztec-labs/kv-store/lmdb-v2", "@aztec-foundation/bb.js"],
    },
  },
});
