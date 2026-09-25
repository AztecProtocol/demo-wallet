// Build-time env injected by Vite in every bundle that includes shared/ (web, Electron renderer/worker).
interface ImportMetaEnv {
  readonly VITE_STAGING_PUBLIC_API_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
