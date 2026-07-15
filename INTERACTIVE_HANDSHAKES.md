# Interactive Handshakes (Aztec v5) — demo-wallet integration

Branch: `mv/interactive-handshakes-demo` (off `main`). Status: **implemented, not yet compiled/run**
(the feature depends on the unmerged wallet-sdk PR stack — see PR1
[AztecProtocol/aztec-packages#24690](https://github.com/AztecProtocol/aztec-packages/pull/24690)).

This wires the `@aztec/wallet-sdk/delivery` interactive-handshake helpers into the demo-wallet's
`BaseWallet`-derived wallets. demo-wallet needs **only PR1** (the delivery helpers); it does not use
`EmbeddedWallet`, so the responder is wired by hand into `DemoWallet` — mirroring
`EmbeddedWallet.respondToInteractiveHandshake` / `restoreInteractiveHandshakesForAccount`.

---

## What was implemented

**Recipient (responder) side** — `DemoWallet.respondToInteractiveHandshake(requestBlob)`:
decodes the sender's request envelope, validates it against the standard HandshakeRegistry, gates on
user **consent through the existing `AuthorizationDialog`**, then runs
`createInteractiveHandshakeResponder({ pxe, getSigningKey, backup })` (which registers the channel,
writes the backup, then signs — in that order). The master message-signing key is derived
client-side via `deriveMasterMessageSigningSecretKey(storedAccountSecret)` and never touches PXE.
Returns the `RecipientSignature` as a relay blob.

**Sender (resolver) side** — PXE hooks in the wallet worker:
`resolveCustomRequest = createInteractiveHandshakeResolver(transport)`, where `transport` drives a
**manual QR / copy-paste relay** (`HandshakeRelayDialog`): it shows the request envelope (QR +
copyable blob) and awaits the recipient's signature blob pasted back. **Timeout-then-retry is a
first-class UI flow** — the relay never hard-fails on a slow recipient; it surfaces a retry
affordance and stays open until the user submits or cancels (cancel fails the pending send).

**Per-contact "private channel" toggle** — drives `resolveTaggingSecretStrategy`:
a contact with the toggle on gets `{ type: 'interactive-handshake' }` (reveals nothing about the
recipient on-chain); everyone else uses the default `{ type: 'non-interactive-handshake' }`. Persisted
per address in a new `senderSettings` table and surfaced as a `Switch` on each `ContactBox`.

**Backup + restore** — a new `handshakeBackups` WalletDB table (fixed-width
`recipient||ephPkX` value, idempotent), mirroring `EmbeddedWallet`'s `WalletDB`. Backups are
re-registered into PXE via `restoreInteractiveHandshakes` whenever an account's keys are (re)registered
(`DemoWallet.getAccountManager`), so channels survive a PXE wipe/reinstall. Deleting an account drops
its backups.

The blob encoding is exactly what the PR intends: the delivery zod schemas
(`InteractiveHandshakeCustomRequestSchema`, `RecipientSignatureSchema`) round-tripped with
`jsonStringify` (encode) / `JSON.parse` + `Schema.parse` (decode).

### Files changed

| Area | File |
|------|------|
| Storage | `shared/src/wallet/database/wallet-db.ts` (handshakeBackups + senderSettings + cleanup) |
| Wallet | `shared/src/wallet/core/demo-wallet.ts` (responder, restore, relay-resolve, ctor arg) |
| Wallet | `shared/src/wallet/core/external-wallet.ts` (ctor arg), `internal-wallet.ts` (toggle getters) |
| Types | `shared/src/wallet/types/handshake.ts` (new), `types/index.ts` (export) |
| IPC | `shared/src/ipc/wallet-internal-interface.ts` (schema + interface) |
| Worker | `app/src/workers/wallet-worker.ts` (PXE hooks + transport + relay map) |
| IPC edges (Electron) | `app/src/ipc/{preload,wallet-internal-proxy}.ts`, `app/src/main.ts`, `app/src/ui/utils/wallet-api.ts` |
| Web target | `web/src/wallet/wallet-service.ts`, `web/src/ui/utils/wallet-api.ts` (parity) |
| UI | `shared/src/ui/App.tsx`, `components/dialogs/HandshakeRelayDialog.tsx` (new), `RespondHandshakeDialog.tsx` (new), `AuthorizationDialog.tsx` (consent case), `sections/contacts/{index.tsx,components/ContactBox.tsx}` |
| Tooling | `scripts/toggle-local-aztec.js` (added `@aztec/standard-contracts` mapping — see below) |

---

## Testing the local PR — runbook

The feature only exists in local aztec-packages (branch that has the delivery helpers). The pinned
`@aztec/*@5.0.0` npm packages do **not** export `@aztec/wallet-sdk/delivery`'s handshake helpers, so
this branch **requires `local-aztec` enabled to build/run.**

1. **Build aztec-packages** on the handshake branch (`mv/f795-embedded-responder` or the branch that
   carries PR1) so each package's `dest/` is compiled — the `link:` resolutions point at `dest/`:
   ```bash
   cd /Users/maximvezenov/Documents/dev/AztecProtocol/aztec-packages/yarn-project && yarn build
   ```

2. **Point demo-wallet at the local build** (first run saves the path):
   ```bash
   cd /Users/maximvezenov/Documents/dev/AztecProtocol/demo-wallet
   node scripts/toggle-local-aztec.js enable /Users/maximvezenov/Documents/dev/AztecProtocol/aztec-packages
   yarn install
   cd extension && yarn install && cd ..
   # subsequently: `yarn local-aztec:enable` (uses the saved path) also does the installs
   ```
   > This branch adds `@aztec/standard-contracts` to the toggle's `PACKAGE_MAPPINGS`. It's a new
   > `workspace:^` dependency of `wallet-sdk` (its delivery code imports the HandshakeRegistry
   > constants) and is not on npm. With the `link:` protocol Yarn resolves a linked package's deps
   > from this repo's tree, so it must be mapped or `yarn install` fails to resolve it. If install
   > still complains about another unmapped `@aztec/* workspace:^`, add it to `PACKAGE_MAPPINGS` too.

3. **Typecheck** (this is the real compile gate — I could not run it here, no `node_modules`):
   ```bash
   yarn typecheck
   ```
   Likely spots to check first if it errors:
   - `createInteractiveHandshakeResponder({ pxe: this.pxe, ... })` in `demo-wallet.ts` — `this.pxe`
     is the lazy-client `PXE`; it must structurally satisfy `InteractiveHandshakeResponderPXE`
     (`getRegisteredAccounts` + `registerTaggingSecretSource`). Cast if the nominal types differ.
   - The `resolveTaggingSecretStrategy` literal unions in `wallet-worker.ts` / `wallet-service.ts`
     (kept as `as const`).
   - `ApiSchemaFor<InternalWalletInterface>` — the new schema entries mirror `resolveAuthorization`
     (void) and the listeners mirror `onWalletUpdate` (not in the schema object).

4. **Run the Electron app:**
   ```bash
   cd app && yarn start
   ```

To go back to npm packages: `yarn local-aztec:disable` (then `yarn install`).

### Manual test flow

You need two wallet instances (two accounts / two profiles / two machines) — a **sender** and a
**recipient** — on the same network.

1. **Recipient** creates an account (backups + restore path exercised on account registration).
2. **Sender** adds the recipient as a contact and flips its **"Private channel"** switch on
   (Contacts tab). This persists the interactive-handshake strategy for that recipient.
3. **Sender** does a private send to that recipient (e.g. a token transfer that delivers a private
   note). PXE fires `resolveCustomRequest` → the **"Relay interactive handshake"** dialog appears
   with a QR + copyable request blob.
4. **Recipient** opens Contacts → **"Respond to handshake"**, pastes the sender's request blob,
   approves the consent dialog, and copies the returned signature blob.
5. **Sender** pastes that signature blob into the relay dialog → **Submit** → the send completes.
6. Verify the recipient discovers the note. Optionally wipe the recipient PXE data dir and
   re-register the account to confirm `restoreInteractiveHandshakes` re-establishes the channel.

Log spots: `~/keychain/aztec-keychain-debug.log`. The strategy hook fires per outgoing message; the
custom-request hook fires once, on the send that bootstraps the tagging secret.

---

## Known limitations / follow-ups

- **Not yet compiled.** Everything was written against the ground-truth SDK API but no `tsc`/lint/run
  has been performed (no `node_modules` in the working tree). Run `yarn typecheck` first.
- **Shared-PXE appId.** The PXE (and thus its hooks) is shared per session across apps; the relay
  request carries the appId captured at session creation. The relay is user-driven so this is
  cosmetic, but a dApp-accurate appId would need per-operation hook context (not in the SDK today).
- **Consent reuse.** Recipient consent reuses the authorization channel with a new
  `respondToInteractiveHandshake` method (a plain content card in `AuthorizationDialog`). It does not
  persist a grant — every response prompts.
- **Docs to update** once verified: add an "Interactive Handshakes" section to `CLAUDE.md`
  (capability/operation tables, the new WalletDB stores `handshakeBackups`/`senderSettings`, the two
  new PXE hooks, and the two new dialogs), and note the `local-aztec` `standard-contracts` mapping.
