// Build-time env injected by Vite in every bundle that includes shared/ (web, Electron renderer/worker).
interface ImportMetaEnv {
  /** Per-network node API keys, named by `apiKeyEnvVar(networkId)`, e.g. `VITE_TESTNET_API_KEY`. */
  readonly [key: `VITE_${string}_API_KEY`]: string | undefined;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
