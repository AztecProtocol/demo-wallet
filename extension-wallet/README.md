# extension-wallet

Self-contained Aztec wallet browser extension. Wallet logic runs inside the extension itself (no Electron dependency), modeled on MetaMask.

This is distinct from the `extension/` directory at the repo root, which is a transport-only relay between dApps and the Electron app at `app/`.

## Development

```bash
yarn install
yarn dev           # Chrome
yarn dev:firefox   # Firefox
```

## Architecture

- `entrypoints/background.ts` — Service worker (router only)
- `entrypoints/offscreen.ts` — Wallet host (PXE, WalletDB, vault)
- `entrypoints/content.ts` — dApp ↔ extension relay
- `entrypoints/popup/` — Status + lock screen
- `entrypoints/approval/` — Per-request approval window
- `entrypoints/expanded/` — Full wallet UI (reuses `StandaloneShell`)
- `entrypoints/onboarding/` — First-install setup wizard

Extension ID (Chromium): _to be filled in after first `wxt prepare` — derived from the `key` in `wxt.config.ts`._

See the design spec at `docs/superpowers/specs/2026-04-28-browser-extension-wallet-design.md`.
