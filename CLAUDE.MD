# Claude Context: Demo Wallet

## Project Overview

This is an Aztec wallet application built with Electron that allows dApps to interact with user accounts through a secure browser extension interface. The wallet manages private keys, handles transaction simulation/execution, and provides **capability-based authorization flows** for dApp requests.

## Architecture

### Communication Flow

The wallet uses **Native Messaging** for secure communication between the browser extension and the Electron app:

```
┌─────────────────┐      stdio            ┌──────────────────┐     Unix socket      ┌──────────────────┐
│ Browser         │ ←──(length-prefix)──→ │ Native Host      │ ←──(newline JSON)──→ │ Electron App     │
│ Extension       │      JSON             │ (compiled binary)│                      │ (wallet-worker)  │
└─────────────────┘                       └──────────────────┘                      └──────────────────┘
```

**Security Model**:
- **dApp** → Content Script: Encrypted payload (ECDH + AES-GCM)
- **Content Script**: Pure relay - NEVER has access to private keys or secrets
- **Background Service Worker**: Decrypts/validates, sends via Native Messaging
- **Native Host**: Bridges stdio ↔ Unix socket (no logic, just relay)
- **Wallet Worker**: Handles actual wallet operations

### Core Components

1. **Electron App (Main Process)** - `/app`
   - Native desktop application
   - Manages wallet instances via worker threads
   - Handles IPC between UI and wallet logic
   - Installs Native Messaging manifests on startup

2. **Browser Extension** - `/extension`
   - Provides interface between dApps and wallet
   - Supports Chromium-based browsers (Chrome, Brave, Edge) and Firefox
   - Uses WXT framework for build tooling

3. **Native Host** - `/app/src/native-host`
   - Compiled binary that bridges extension ↔ Electron
   - Communicates via stdio with extension, Unix socket with Electron
   - Platform-specific builds: `darwin-arm64`, `darwin-x64`, `linux-x64`, `win32-x64`

4. **Wallet Worker** - `app/src/workers/wallet-worker.ts`
   - Manages PXE (Private Execution Environment) instances
   - Handles wallet operations (simulate, send, register contracts)
   - Maintains session state per network (chainId-version)
   - Creates separate wallet instances per app for authorization isolation

### Key Architectural Decisions

#### Single PXE Instance Per Session

**Critical**: Each network session (identified by `chainId-version`) has **one shared PXE instance** used by all apps. Multiple PXE instances per session causes JavaScript Maps to get out of sync with LMDB, leading to `Cannot read properties of undefined (reading 'getValuesAsync')` errors.

**Structure** (`wallet-worker.ts`):

```typescript
type SessionData = {
  sharedResources: Promise<{
    pxe: any;    // Shared across all apps
    node: any;   // Shared across all apps
    db: any;     // Shared across all apps
    pendingAuthorizations: Map<string, any>;
  }>;
  wallets: Map<string, Promise<{ external: ExternalWallet; internal: InternalWallet }>>;
};

const RUNNING_SESSIONS = new Map<string, SessionData>();
```

#### External vs Internal Wallets

- **ExternalWallet**: Handles requests from dApps (via extension) - requires authorization
- **InternalWallet**: Handles internal requests (UI, account management) - bypasses authorization
- Both share the same PXE, node, db, and authorization state

---

## Capability-Based Authorization System

### Overview

The wallet implements a **capability-based authorization model** where dApps request granular permissions that persist across sessions. This replaces ad-hoc authorization for individual operations with declarative capability manifests.

### Capability Types

Six capability types from `@aztec/aztec.js/wallet`:

#### 1. Accounts Capability
```typescript
{
  type: "accounts",
  canGet: boolean,           // Access to getAccounts()
  canCreateAuthWit: boolean, // Permission to create auth witnesses
  accounts: Aliased<AztecAddress>[]  // Specific accounts granted
}
```
- **Storage Keys**: `"getAccounts"`, `"createAuthWit"`
- **UI**: Allows selecting specific accounts with optional auth witness permissions

#### 2. Contracts Capability
```typescript
{
  type: "contracts",
  contracts: AztecAddress[] | "*",
  canRegister: boolean,
  canGetMetadata: boolean
}
```
- **Storage Keys**: `"registerContract:address"`, `"getContractMetadata:address"`
- Supports per-contract granularity

#### 3. Contract Classes Capability
```typescript
{
  type: "contractClasses",
  classes: Fr[] | "*",
  canGetMetadata: boolean
}
```
- **Storage Keys**: `"getContractClassMetadata:classId"`

#### 4. Simulation Capability
```typescript
{
  type: "simulation",
  transactions?: { scope: "*" | ContractFunctionPattern[] },
  utilities?: { scope: "*" | ContractFunctionPattern[] }
}
```
- **Storage Keys**: `"simulateTx:contract:function"`, `"simulateUtility:contract:function"`
- Supports wildcard (`"*"`) or specific contract/function patterns

#### 5. Transaction Capability
```typescript
{
  type: "transaction",
  scope: "*" | ContractFunctionPattern[]
}
```
- **Storage Keys**: `"sendTx:contract:function"`
- **Critical**: Always requires user approval even if pre-granted

#### 6. Data Capability
```typescript
{
  type: "data",
  addressBook?: boolean,
  privateEvents?: { contracts: AztecAddress[] | "*" }
}
```
- **Storage Keys**: `"getAddressBook"`, `"getPrivateEvents:address"`

### Authorization Flow

1. **dApp requests capabilities** via `wallet.requestCapabilities(manifest)`
2. **Wallet checks existing grants** - if all non-transaction capabilities granted, may skip UI
3. **Authorization UI shown** with capability list, checkboxes for each permission
4. **User approves/denies** individual capabilities
5. **Grants stored persistently** as storage keys in LMDB
6. **Subsequent operations** check stored grants before showing authorization

### Authorization Behavior Settings

Per-app settings stored separately from capability grants:

- **Mode**: `"strict"` (only pre-approved operations) or `"permissive"` (allow ad-hoc)
- **Duration**: Expiration time for all grants (default: 30 days)

**Strict Mode**: Rejects any operation not covered by declared capabilities. Prevents privilege escalation via ad-hoc requests.

### Wildcard Pattern Matching

Authorization manager supports progressive wildcard matching:
- `"registerContract:0x123..."` → tries `"registerContract:*"`
- `"simulateTx:0x123...:swap"` → tries `"simulateTx:0x123...:*"` → `"simulateTx:*"`

### Key Implementation Files

| File | Purpose |
|------|---------|
| `request-capabilities-operation.ts` | Core capability request operation (3-phase pattern) |
| `AuthorizeCapabilitiesContent.tsx` | UI component for capability authorization |
| `AppAuthorizationCard.tsx` | UI for viewing/editing authorized apps |
| `authorization-manager.ts` | Checks grants, wildcard matching, strict mode |
| `wallet-db.ts` | Storage methods for capability grants |

---

## Database Structure

### WalletDB (`wallet-db.ts`)

Uses LMDB (via `@aztec/kv-store/lmdb-v2`) for persistent storage:

| Store | Purpose |
|-------|---------|
| `accounts` | Account data indexed by address |
| `aliases` | Human-readable names for addresses |
| `interactions` | History of all wallet operations |
| `authorizations` | Persistent capability grants (keyed by `appId:storageKey`) |
| `txSimulations` | Cached simulation results with metadata |
| `bridgedFeeJuice` | Fee payment token management |

### Capability Storage Methods

```typescript
// Convert capability to storage keys
capabilityToStorageKeys(capability: GrantedCapability): string[]

// Store granted capabilities (clears old grants first)
storeCapabilityGrants(appId: string, granted: GrantedCapability[]): Promise<void>

// Check which keys are already authorized
checkAuthorizationKeys(appId: string, keys: string[]): Promise<Map<string, boolean>>

// Store app behavior settings (mode + expiration)
storeAppAuthorizationBehavior(appId: string, mode: string, duration: number): Promise<void>

// Reconstruct capabilities from stored keys (for display)
reconstructCapabilitiesFromKeys(appId: string): Promise<GrantedCapability[]>
```

### PXE Storage

PXE maintains its own LMDB database at `~/keychain/pxe-${rollupAddress}`:
- Note synchronization data
- Contract artifacts and instances
- Encrypted notes per account

---

## ExternalOperation Pattern

All authorization-requiring operations extend `ExternalOperation` with a 4-phase pattern:

### Phase 1: Check (optional early return)
```typescript
async check(...args): Promise<ResultType | undefined> {
  // Return result for early exit if operation already completed/authorized
  // Return undefined to continue to prepare phase
}
```

### Phase 2: Prepare (build display data)
```typescript
async prepare(...args): Promise<PrepareResult<Result, Display, Execution>> {
  // Query necessary data
  // Build display data for authorization UI
  // Build execution data for execute phase
  // MUST be side-effect free (user might deny)
  return { displayData, executionData, persistence };
}
```

### Phase 3: Request Authorization
```typescript
async requestAuthorization(displayData, persistence?) {
  await this.emitProgress("REQUESTING AUTHORIZATION", ...);
  await this.authorizationManager.requestAuthorization([{
    id: crypto.randomUUID(),
    appId: this.authorizationManager.appId,
    method: "methodName",
    params: displayData,
    timestamp: Date.now(),
    persistence,
  }]);
}
```

### Phase 4: Execute
```typescript
async execute(executionData): Promise<ResultType> {
  // Perform the actual operation (only called after approval)
  const result = await this.pxe.doSomething(executionData);
  await this.emitProgress("SUCCESS", undefined, true);
  return result;
}
```

### Key Principles

- **Prepare must be side-effect free** - user might deny
- **Never persist to PXE during prepare** - only during execute
- **Display data must be serializable** for IPC to authorization UI
- **Transaction capabilities always require approval** - never skip authorization

---

## Important Code Patterns

### DecodingCache

Manages contract metadata resolution with three caches:
- `instanceCache`: `AztecAddress` → `ContractInstanceWithAddress`
- `artifactCache`: `contractClassId` → `ContractArtifact`
- `addressAliasCache`: `AztecAddress` → human-readable name

**Critical Rule**: Only cache successfully resolved data. Never cache fallback values (like shortened addresses) or they prevent future resolution.

### Zod Schemas for IPC

All data crossing IPC boundaries must have Zod schemas:
- `InternalWalletInterfaceSchema` in `wallet-internal-interface.ts`
- Update schemas when adding new methods or return types

### Internal vs External Authorization

Some operations have different authorization requirements based on origin:
- **External**: From dApps via extension → requires user authorization
- **Internal**: From wallet UI → bypasses authorization

Example: Auth witness creation during `sendTx`:
- `createAuthWit` from dApp → requires authorization dialog
- Internal auth witness for call authorizations → no dialog (tx already approved)

---

## UI Components

### Authorization Components

| Component | Purpose |
|-----------|---------|
| `AuthorizeCapabilitiesContent.tsx` | Capability authorization with granular checkboxes |
| `AuthorizeSendTxContent.tsx` | Send transaction authorization |
| `AuthorizeSimulateTxContent.tsx` | Simulation authorization |

### Authorized Apps Management

| Component | Purpose |
|-----------|---------|
| `AppAuthorizationCard.tsx` | View/edit granted capabilities per app |
| `AuthorizedApps/index.tsx` | List all authorized apps |

### Key Features

- **Granular permission checkboxes**: Select specific accounts, contracts, functions
- **Indeterminate checkbox states**: Partial selection shown with dash icon
- **Debounced auto-save**: 500ms delay prevents excessive DB writes
- **Smart initialization**: First-time apps pre-select all; returning apps only pre-select granted

---

## Development Setup

### Requirements

- Node.js v22
- yarn
- Running Aztec node (local or remote)

### Running

```bash
# 1. Install dependencies
cd app
yarn install

# 2. Build native host (required for extension communication)
yarn build:native-host

# 3. Start the wallet
yarn start

# 4. In another terminal, start the extension
cd extension
yarn install
yarn dev  # Launches browser with extension
```

### Native Messaging Setup (Dev Mode)

In dev mode, Chrome uses a custom profile that only checks system-wide manifest locations.
See README.md for platform-specific instructions on installing the manifest with `sudo`.

---

## Logging

### Logger Usage

- Use `createProxyLogger` for worker threads
- Include context in logger names (e.g., `wallet:external:${appId}`)
- Avoid excessive logging in production code
- Debug logs helped identify the PXE multi-instance issue

### Log Locations

| Component | Path |
|-----------|------|
| Electron App (full logs) | `~/keychain/aztec-keychain-debug.log` |
| Native Host | `~/keychain/native-host.log` |
| LMDB data | `~/keychain/pxe-${rollupAddress}` |

### IPC Socket

| Platform | Path |
|----------|------|
| macOS/Linux | `~/keychain/wallet.sock` |
| Windows | `\\.\pipe\aztec-keychain-wallet` |

---

## Debugging Tips

### Check PXE Instance Count

Look for log messages in `~/keychain/aztec-keychain-debug.log`:
```
[PXE-INIT] Creating NEW session with shared PXE instance for sessionId=...
[PXE-INIT] Reusing existing shared PXE instance for sessionId=...
```

Should only see one "Creating NEW" per network session.

### Check Authorization Flow

External = from dApp, Internal = from wallet UI:
```
Received external message: ...
Received internal message: ...
```

### Native Messaging Issues

1. Check `~/keychain/native-host.log` for connection errors
2. Verify manifest installed in correct location (system-wide for dev mode)
3. Confirm extension ID in manifest matches installed extension

### Note Synchronization Errors

If you see `Cannot read properties of undefined (reading 'getValuesAsync')`:
- Check `~/keychain/aztec-keychain-debug.log` for full logs
- Verify only one PXE instance is being created per session
- Check LMDB data directory: `~/keychain/pxe-${rollupAddress}`

### Performance Issues

- Check if `DecodingCache` is being reused (should be singleton per wallet)
- Monitor database query times
- Look for unnecessary re-renders in React components

---

## File Reference

### Core Wallet Files

| File | Purpose |
|------|---------|
| `wallet-worker.ts` | Session and PXE management |
| `external-wallet.ts` | dApp request handling |
| `internal-wallet.ts` | Internal operations |
| `wallet-db.ts` | Persistent storage |
| `authorization-manager.ts` | Authorization checks, wildcard matching |
| `decoding-cache.ts` | Contract metadata resolution |

### Operation Files (`app/src/wallet/operations/`)

| File | Purpose |
|------|---------|
| `base-operation.ts` | ExternalOperation base class |
| `request-capabilities-operation.ts` | Capability grant handling |
| `send-tx-operation.ts` | Transaction sending |
| `simulate-tx-operation.ts` | Transaction simulation |
| `simulate-utility-operation.ts` | Utility function simulation |
| `register-contract-operation.ts` | Contract registration |
| `create-authwit-operation.ts` | Auth witness creation |
| `get-accounts-operation.ts` | Account access |
| `get-address-book-operation.ts` | Address alias access |
| `get-private-events-operation.ts` | Private event queries |
| `get-contract-metadata-operation.ts` | Contract metadata queries |
| `get-contract-class-metadata-operation.ts` | Contract class metadata |

### IPC Files

| File | Purpose |
|------|---------|
| `wallet-internal-interface.ts` | IPC type definitions + Zod schemas |
| `preload.ts` | Electron preload script |
| `main.ts` | Main process IPC handlers |

### Extension Files (`extension/`)

| File | Purpose |
|------|---------|
| `entrypoints/background.ts` | Native messaging, session handling |
| `entrypoints/content.ts` | Pure relay content script |
| `wxt.config.ts` | Extension configuration, public key |

### UI Files

| Directory | Purpose |
|-----------|---------|
| `app/src/ui/components/authorization/*` | Authorization dialogs |
| `app/src/ui/components/dialogs/*` | Modals and dialogs |
| `app/src/ui/components/shared/*` | Reusable components |
| `app/src/ui/components/sections/*` | Main UI sections |

### Configuration

| File | Purpose |
|------|---------|
| `app/src/config/networks.ts` | Network definitions |
| `app/src/native-messaging.ts` | Manifest installation |
| `app/vite.main.config.ts` | Build config, extension ID computation |

---

## Design Principles

1. **Single PXE per session** - Multiple PXE instances sharing the same LMDB database cause JavaScript Maps to desync with persistent storage

2. **DecodingCache: only cache resolved data** - Never cache fallback values (like shortened addresses) as they prevent future resolution when real data becomes available

3. **Prepare phase must be side-effect free** - Users might deny authorization, so never persist during prepare

4. **Transaction capabilities always require approval** - By design, even pre-granted transaction capabilities still show the authorization dialog

5. **Update all registries when adding interaction types**:
   - `WalletInteractionType` type
   - `WalletInteractionSchema` enum
   - `labels`, `colors`, `allInteractionTypes` in interactions/index.tsx
   - `selectedInteractionTypes` in App.tsx

---

## Known Limitations

1. **Transaction Capabilities**: Always require approval per-transaction (by design)
2. **Strict Mode**: Completely blocks ad-hoc operations (intentional security feature)
3. **Extension ID**: Must use manifest public key for stable ID computation

## Future Improvements

1. **Account Derivation**: BIP-44 HD wallet support
2. **Hardware Wallets**: Ledger/Trezor integration
3. **Advanced Fee Estimation**: Better gas estimation and fee payment methods
4. **Capability Expiration**: Auto-cleanup of expired grants
