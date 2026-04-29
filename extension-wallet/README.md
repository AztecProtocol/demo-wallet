# extension-wallet

Self-contained Aztec wallet browser extension. Wallet logic runs inside the extension itself (no Electron dependency), modeled on MetaMask.

This is distinct from `extension/` at the repo root, which is a transport-only relay between dApps and the Electron app at `app/`.

## Development

```bash
yarn install        # also runs `wxt prepare` to generate .wxt/
yarn dev            # Chrome
yarn dev:firefox    # Firefox
yarn test           # vitest unit tests
yarn compile        # tsc --noEmit
```

`yarn dev` opens a Chrome instance with the extension loaded and an isolated profile. The first run pops an onboarding tab automatically.

## Architecture

```
            ┌───────────────────────────────┐
            │ dApp page (any origin)        │
            └────┬──────────────────────────┘
        content script (entrypoints/content.ts)
                 │
                 ▼
            ┌───────────────────────────────┐
            │ Background service worker     │
            │ (entrypoints/background.ts)   │
            │  - BackgroundConnectionHandler│
            │  - Approval window queue      │
            │  - Auto-lock alarm            │
            │  - Remembered apps            │
            └────┬──────────────────────────┘
       chrome.runtime.Port (PortClient ↔ PortServer)
                 │
                 ▼
            ┌───────────────────────────────┐
            │ Offscreen document            │
            │ (entrypoints/offscreen.ts)    │
            │  - VaultState (lock/unlock)   │
            │  - WalletHost (RPC dispatch)  │
            │  - PXE / WalletDB / shared    │
            │    session (lifted from web/) │
            └───────────────────────────────┘
                 ▲                    ▲
                 │                    │
   ┌─────────────┘                    └────────────────┐
   │                                                   │
┌──────────────────┐                       ┌─────────────────────┐
│ Popup            │                       │ Approval window     │
│ (lock screen +   │                       │ (per-request)       │
│  status)         │                       └─────────────────────┘
└──────────────────┘
                                            ┌─────────────────────┐
                                            │ Expanded view       │
                                            │ (StandaloneShell    │
                                            │  from shared/)      │
                                            └─────────────────────┘
```

### Files

- `entrypoints/background.ts` — Service worker (router only)
- `entrypoints/offscreen.ts` — Wallet host bootstrap
- `entrypoints/content.ts` — dApp ↔ extension relay
- `entrypoints/popup/` — Status + lock screen
- `entrypoints/approval/` — Per-request approval window
- `entrypoints/expanded/` — Full wallet UI (reuses `StandaloneShell` from `@demo-wallet/shared/ui`)
- `entrypoints/onboarding/` — First-install setup wizard
- `src/vault/` — Argon2id KDF, vault metadata store, lock state machine
- `src/ipc/` — Port message envelope (Zod), `PortServer` (offscreen-side), `PortClient` (UI/SW-side)
- `src/offscreen/wallet-host.ts` — Wires `VaultState`, the lifted session manager, and `PortServer`
- `src/background/` — SW helpers: offscreen lifecycle, approval queue, auto-lock alarm, remembered apps
- `src/ui/port-wallet-api.ts` — Builds an `InternalWalletInterface` Proxy that forwards over `PortClient`

### RPC namespaces

The port server multiplexes four namespaces:

| Prefix       | Caller          | Target           | Examples                                    |
|--------------|-----------------|------------------|---------------------------------------------|
| `vault.*`    | UI surfaces     | `VaultState`     | `vault.unlock`, `vault.isUnlocked`          |
| `network.*`  | UI surfaces     | host config      | `network.set`, `network.get`                |
| `wallet.*`   | UI surfaces     | `InternalWallet` | `wallet.getAccounts`, `wallet.createAccount`|
| `dapp.*`     | dApp (via SW)   | `ExternalWallet` | `dapp.simulateTx`, `dapp.sendTx`            |

`wallet.*` and `dapp.*` are populated dynamically by enumerating `InternalWalletInterfaceSchema` and `WalletSchema`.

## Extension ID

The Chromium extension ID is derived from the `key` field in `wxt.config.ts`. Run `yarn dev` once and look at the `chrome://extensions` page — the ID will appear under the loaded extension. Copy it back into this README if you want it handy.

## Browser support

- **Chrome / Brave / Edge**: full support via `chrome.offscreen`.
- **Firefox**: no `chrome.offscreen` API; falls back to a hidden minimized window hosting `offscreen.html` (see `src/background/offscreen-lifecycle.ts`).

## Coexistence with `extension/`

Both extensions can be installed side-by-side. They use different `WALLET_ID`s (`aztec-extension-wallet` vs `aztec-keychain`), so the wallet-sdk discovery flow lists both as options in dApp wallet pickers.

## Known deviations from the design plan

- **`dapp.*` and `wallet.*` dispatch use explicit schema-key enumeration** (not a JS `Proxy`). Rationale: spreading a Proxy into a plain object loses the `get` trap, defeating the dispatcher.
- **Approval window uses `authorization.getPending`** (one-shot read at mount) instead of a broadcast-replay mechanism. Avoids spamming every open UI surface with re-broadcasts of every pending auth.
- **`tsconfig.json` overrides `strict: false`** to match `web/`/`shared/` workspace conventions. WXT's auto-generated config is `strict: true`, but `shared/`'s source isn't strict-clean, so following imports under strict tsc would fail in unrelated files. Re-enabling strict mode is gated on making `shared/` strict-clean first.

## Caveats (v1)

- **At-rest encryption is deferred.** The vault uses Argon2id + a probe-based password check, but account secrets are stored in plaintext in IndexedDB. This is intentional pending the in-progress IndexedDB replacement; the lock UX is preserved so the surface area doesn't change when encryption is added later.

## Design

See `docs/superpowers/specs/2026-04-28-browser-extension-wallet-design.md` for the full design.
