# Claude Context: Demo Wallet

## Project Overview

This is an Aztec wallet application built with Electron that allows dApps to interact with user accounts through a secure browser extension interface. The wallet manages private keys, handles transaction simulation/execution, and provides authorization flows for dApp requests.

## Architecture

### Core Components

1. **Electron App (Main Process)**
   - Native desktop application
   - Manages wallet instances via worker threads
   - Handles IPC between UI and wallet logic
   - Located in `/app`

2. **Browser Extension**
   - Provides interface between dApps and wallet
   - Supports Chromium-based browsers (Chrome, Brave, Edge) and Firefox
   - Located in `/extension` (separate repository)
   - Communicates with wallet via WebSocket on port **8765**

3. **Wallet Worker (`wallet-worker.ts`)**
   - Manages PXE (Private Execution Environment) instances
   - Handles wallet operations (simulate, send, register contracts)
   - Maintains session state per network (chainId-version)
   - Creates separate wallet instances per app for authorization isolation

4. **WebSocket Worker (`ws-worker.ts`)**
   - Runs WebSocket server on port 8765
   - Bridges extension ↔ wallet communication
   - **Temporary**: Should use Native Messaging API instead

### Key Architectural Decisions

#### Single PXE Instance Per Session

**Critical**: Each network session (identified by `chainId-version`) has **one shared PXE instance** used by all apps. Multiple PXE instances per session causes JavaScript Maps to get out of sync with LMDB, leading to `Cannot read properties of undefined (reading 'getValuesAsync')` errors.

**Structure** (`wallet-worker.ts`):
```typescript
type SessionData = {
  sharedResources: Promise<{
    pxe: any;           // Shared across all apps
    node: any;          // Shared across all apps
    db: any;            // Shared across all apps
    pendingAuthorizations: Map<string, any>;
  }>;
  wallets: Map<string, Promise<{ external: ExternalWallet; internal: InternalWallet }>>;
};

const RUNNING_SESSIONS = new Map<string, SessionData>();
```

- **Session Level**: One PXE per network, indexed by `sessionId`
- **App Level**: Separate `ExternalWallet` and `InternalWallet` instances per `appId`
- **Why**: PXE's `NoteDataProvider` maintains JavaScript Maps that must stay in sync with LMDB

#### External vs Internal Wallets

- **ExternalWallet**: Handles requests from dApps (via extension)
- **InternalWallet**: Handles internal requests (UI, account management)
- Both share the same PXE, node, db, and authorization state

#### Authorization Flow

1. dApp sends request → Extension → WebSocket → Wallet Worker
2. Wallet simulates transaction and creates `AuthorizationRequest`
3. Authorization dialog shown to user in Electron UI
4. User approves/denies → Response sent back through chain
5. Authorized operations can be persisted (e.g., `simulateTx` with payload hash)

## Database Structure

### WalletDB (`wallet-db.ts`)

Uses LMDB (via `@aztec/kv-store/lmdb-v2`) for persistent storage:

- **accounts**: Account data indexed by address
- **aliases**: Human-readable names for addresses
- **interactions**: History of all wallet operations
- **authorizations**: Persistent authorization grants (keyed by `appId:method:item`)
- **txSimulations**: Cached simulation results with metadata
  - Stores: `{ simulationResult, txRequest, metadata: { from, embeddedPaymentMethodFeePayer } }`
- **bridgedFeeJuice**: Fee payment token management

### PXE Storage

PXE maintains its own LMDB database at `~/keychain/pxe-${rollupAddress}`:
- Note synchronization data
- Contract artifacts and instances
- Encrypted notes per account

## Common Issues & Fixes

### 1. PXE Note Synchronization Error

**Symptom**: `Cannot read properties of undefined (reading 'getValuesAsync')` after deleting authorizations or creating new accounts.

**Root Cause**: Multiple PXE instances sharing the same LMDB database. When `addScope()` is called and the scope already exists in LMDB, it returns early without populating JavaScript Maps.

**Solution**:
1. Ensure only one PXE per session (fixed in `wallet-worker.ts`)
2. Defensive fix in PXE's `note_data_provider.js` for lazy Map initialization (see patch file)

**Files**:
- `app/src/workers/wallet-worker.ts`: Single PXE per session
- `app/node_modules/@aztec/pxe/dest/storage/note_data_provider/note_data_provider.js`: Defensive fix
- `pxe-note-provider-map-sync-fix.patch`: Patch file for Aztec repo

### 2. Batch Authorization Denial

**Symptom**: Operations stuck in "requesting authorization" after user clicks "Deny All".

**Root Cause**: Batch method in `external-wallet.ts` didn't catch authorization denial error.

**Solution**: Wrap `requestAuthorization` in try-catch and mark items as ERROR on denial.

**File**: `app/src/wallet/core/external-wallet.ts`

### 3. Execution Trace Performance

**Symptom**: Unreasonable delay when opening execution trace dialog.

**Root Cause**: `getExecutionTrace()` was creating a new `DecodingCache` instance on every call.

**Solution**: Use shared `this.decodingCache` from `BaseNativeWallet`.

**File**: `app/src/wallet/core/internal-wallet.ts:196-229`

### 4. Stats Not Showing After Authorization

**Symptom**: Simulation stats visible during authorization but not when clicking stored interactions.

**Root Cause**: `getExecutionTrace()` wasn't returning stats from stored simulations.

**Solution**: Update return type and extract stats from both utility traces and tx simulations.

**Files**:
- `app/src/wallet/core/internal-wallet.ts`
- `app/src/wallet/database/wallet-db.ts`

### 5. Utility Trace Confusion

**Symptom**: `getUtilityTrace()` returning data for tx simulations.

**Root Cause**: Method didn't check if `utilityTrace` field actually existed in stored data.

**Solution**: Add check `if (!parsed.utilityTrace) return undefined;`

**File**: `app/src/wallet/database/wallet-db.ts`

## Important Code Patterns

### Fee Payer Information

When a transaction includes `embeddedPaymentMethodFeePayer`, the app is providing the fee payment method:
- Extract from `opts.fee?.embeddedPaymentMethodFeePayer` or `executionPayload.feePayer`
- Store in metadata when saving simulations
- Display in authorization dialogs and execution traces with success alert

### MulticallEntrypoint Detection

When `from` is set to `AztecAddress.ZERO`, the request uses MulticallEntrypoint:
- Does not execute from any user account
- Display reassuring info alert in authorization dialogs

### Simulation Title Generation

Use `generateSimulationTitle()` from `simulation-utils.ts`:
- Includes contract names and function calls
- Handles fee payer information
- Provides readable titles for UI

### Zod Schemas for IPC

All data crossing IPC boundaries must have Zod schemas:
- `InternalWalletInterfaceSchema` in `wallet-internal-interface.ts`
- Serialization/deserialization handled automatically
- Update schemas when adding new fields to return types

## UI Components

### Authorization Dialogs

- `AuthorizeSendTxContent.tsx`: Send transaction authorization
- `AuthorizeSimulateTxContent.tsx`: Simulation authorization
- Display fee payer and MulticallEntrypoint alerts

### Execution Trace Display

- `ExecutionTraceDisplay.tsx`: Shows decoded execution with timing stats
- `ExecutionTraceDialog.tsx`: Modal dialog for viewing stored interactions
- `SimulationStatsDisplay`: Collapsible accordion with function hierarchy and RPC calls

### Features

- Collapsible simulation timing stats (default collapsed)
- Function call hierarchy with tree visualization
- RPC calls table sorted by total time
- Call authorization display
- Automatic contract/function decoding via `DecodingCache`

## Development Setup

### Requirements

- Node.js v22
- yarn
- Running Aztec node (local or remote)

### Running

```bash
# Wallet
cd app
yarn install
yarn start

# Extension
cd extension
yarn install
yarn dev  # Launches browser with extension
```

### Port Configuration

- **WebSocket**: Port 8765 (configurable in `ws-worker.ts`)
- **Node RPC**: Default port 8080 (configured in `networks.ts`)

## Testing Scenarios

### Creating and Revoking Authorizations

**Critical Test**: This scenario previously triggered the PXE synchronization bug:

1. Create account "ECDSAR1 0"
2. Complete app onboarding (simulations, transactions, contract registrations)
3. Revoke ALL authorizations for the app
4. Create new account "ECDSAR1 1"
5. Attempt app onboarding again

**Expected**: Should work without errors
**Previously**: Failed with `getValuesAsync` undefined error

### Batch Operations

Test "Deny All" in batch authorization dialogs:
- Should mark all pending operations as ERROR
- Should not leave operations stuck in "requesting authorization"

### Execution Trace Performance

- Opening execution trace dialog should be instant
- No delays or multiple decoding cache instantiations

## Code Quality Guidelines

### Error Handling

- Always wrap authorization requests in try-catch
- Contextualize errors with relevant data (use `contextualizeError`)
- Log meaningful messages at appropriate levels

### Resource Management

- Reuse shared resources (PXE, node client, caches)
- Never create duplicate PXE instances for the same session
- Clean up event listeners when destroying wallet instances

### Logging

- Use `createProxyLogger` for worker threads
- Include context in logger names (e.g., `wallet:external:${appId}`)
- Avoid excessive logging in production code
- Debug logs helped identify the PXE multi-instance issue

### TypeScript

- Use strict typing for operation display data
- Define explicit types for IPC message parameters
- Avoid `any` except for Zod schemas (with `@ts-ignore`)

## Known Limitations

1. **WebSocket Communication**: Should use Native Messaging API instead
2. **Port Management**: Port 8765 must be available
3. **Single Network**: Currently only supports one rollup version at a time
4. **Authorization Persistence**: Limited to `appId:method:item` format

## Future Improvements

1. **Native Messaging**: Replace WebSocket with browser's native extension-to-app communication
2. **Multi-Network**: Support multiple networks simultaneously
3. **Account Derivation**: BIP-44 HD wallet support
4. **Hardware Wallets**: Ledger/Trezor integration
5. **Fee Estimation**: Better gas estimation and fee payment methods
6. **Transaction History**: Enhanced filtering and search
7. **Contact Book**: Address aliases and management

## File Reference

### Critical Files

- `app/src/workers/wallet-worker.ts`: Session and PXE management
- `app/src/wallet/core/external-wallet.ts`: dApp request handling
- `app/src/wallet/core/internal-wallet.ts`: Internal operations
- `app/src/wallet/database/wallet-db.ts`: Persistent storage
- `app/src/wallet/operations/*.ts`: Operation implementations
- `app/src/ipc/wallet-internal-interface.ts`: IPC type definitions

### UI Files

- `app/src/ui/components/authorization/*`: Authorization dialogs
- `app/src/ui/components/dialogs/*`: Modals and dialogs
- `app/src/ui/components/shared/*`: Reusable components
- `app/src/ui/components/sections/*`: Main UI sections

### Configuration

- `app/src/config/networks.ts`: Network definitions
- `app/package.json`: Dependencies and scripts
- `README.md`: Setup instructions

## Debugging Tips

### Check PXE Instance Count

Look for log messages:
```
[PXE-INIT] Creating NEW session with shared PXE instance for sessionId=...
[PXE-INIT] Reusing existing shared PXE instance for sessionId=...
```

Should only see one "Creating NEW" per network session.

### Authorization Flow

Check logs for:
```
Received external message: ...
Received internal message: ...
```

External = from dApp, Internal = from wallet UI

### Note Synchronization

If errors occur, check:
- `~/keychain/aztec-keychain-debug.log` for full logs
- Whether multiple PXE instances are being created
- LMDB data directory: `~/keychain/pxe-${rollupAddress}`

### Performance Issues

- Check if `DecodingCache` is being reused (should be singleton per wallet)
- Monitor database query times
- Look for unnecessary re-renders in React components

## Version Information

- **Node.js**: v22
- **Electron**: (check `app/package.json`)
- **Aztec SDK**: (check `app/package.json` for `@aztec/*` packages)
- **React**: (check `app/package.json`)

## Related Repositories

- **Extension**: `../extension` (sibling directory)
- **Aztec Packages**: Official Aztec monorepo (for PXE patches)

## Patch Files

- `pxe-note-provider-map-sync-fix.patch`: Fix for PXE note synchronization issue
  - Apply to: `yarn-project/pxe/src/storage/note_data_provider/note_data_provider.ts`
  - Command: `git apply /path/to/patch` or `git am /path/to/patch`
