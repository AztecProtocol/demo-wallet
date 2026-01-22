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
    pxe: any; // Shared across all apps
    node: any; // Shared across all apps
    db: any; // Shared across all apps
    pendingAuthorizations: Map<string, any>;
  }>;
  wallets: Map<
    string,
    Promise<{ external: ExternalWallet; internal: InternalWallet }>
  >;
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

**Supported Operations**:

- **Transaction Operations**: `simulateTx`, `sendTx`, `profileTx`
- **Account Management**: `createAccount`, `getAccounts`, `registerSender`
- **Contract Operations**: `registerContract`, `getContractMetadata`, `getContractClassMetadata`
- **Privacy-Sensitive**: `getPrivateEvents`, `getAddressBook`
- **Security-Critical**: `createAuthWit` (requires explicit authorization)

#### Internal vs External Authorization

**Critical Distinction**: Some operations that seem identical have different authorization requirements depending on their origin:

- **External Operations**: Require user authorization (from dApps via extension)
- **Internal Operations**: Bypass authorization (from wallet UI or internal workflows)

**Example**: Auth witness creation during `sendTx`:

- When a dApp calls `createAuthWit`: Requires authorization dialog
- When `sendTx` internally creates auth witnesses for call authorizations: No dialog (user already approved the transaction)

**Implementation** (`external-wallet.ts`):

```typescript
// Public method - requires authorization
async createAuthWit(from: AztecAddress, auth: CallIntent): Promise<AuthWitness> {
  // ... goes through CreateAuthWitOperation with authorization
}

// Private method - bypasses authorization for internal use
private async createAuthWitForSendTx(from: AztecAddress, auth: CallIntent): Promise<AuthWitness> {
  const account = await this.getAccountFromAddress(from);
  return account.createAuthWit(auth, this.chainInfo);
}
```

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

### 6. Batch Contract Registration with Omitted Artifacts

**Symptom**: Batch contract registration fails with "artifact is required but not provided" when later contracts omit redundant artifacts.

**Root Cause**: Logic bug in `register-contract-operation.ts:191` - checked wrong variable after fetching artifact from PXE.

**Solution**: Change condition from `if (!artifact)` to `if (!existingArtifact)`

**Code**:

```typescript
// BEFORE (WRONG):
const existingArtifact = await this.pxe.getContractArtifact(instance.currentContractClassId);
if (!artifact) {  // Wrong variable!
  throw new Error(...);
}

// AFTER (CORRECT):
const existingArtifact = await this.pxe.getContractArtifact(instance.currentContractClassId);
if (!existingArtifact) {  // Check what we just fetched!
  throw new Error(...);
}
```

**File**: `app/src/wallet/operations/register-contract-operation.ts:191`

### 7. Contract Names Not Resolving After Registration

**Symptom**: After registering a contract, simulations still show shortened addresses instead of contract names.

**Root Cause**: `DecodingCache` was caching shortened address fallbacks, preventing later name resolution.

**Solution**:

1. Don't cache shortened addresses in `getAddressAlias()` (line 114-115)
2. Add `instance.currentContractClassId` lookup in `resolveContractName()` (lines 138-150)
3. Add error handling for undefined contract instances

**Critical Pattern**: Never cache fallback values - only cache actual resolved data.

**Files**:

- `app/src/wallet/decoding/decoding-cache.ts:114-115, 138-150`

### 8. Premature "MINING" Status During Account Creation

**Symptom**: Account creation briefly shows "MINING" status immediately after clicking, before proving completes.

**Root Cause**: `internal-wallet.ts` updated status to "MINING" before calling `sendTx.wait()`.

**Solution**: Remove premature status update - let `sendTx` handle status progression (PREPARING → PROVING → MINING).

**File**: `app/src/wallet/core/internal-wallet.ts` (removed lines 129-133)

## Important Code Patterns

### DecodingCache and Artifact Resolution

**Critical Component**: `DecodingCache` manages three types of caches for contract metadata resolution:

1. **instanceCache**: Maps `AztecAddress` → `ContractInstanceWithAddress`
2. **artifactCache**: Maps `contractClassId` → `ContractArtifact`
3. **addressAliasCache**: Maps `AztecAddress` → human-readable name

**Cache Lifecycle**:

- Shared across all operations within a wallet instance
- Cleared when wallet instance is destroyed
- NEVER cache fallback/temporary values (e.g., shortened addresses)

**Batch Artifact Sharing**:

When multiple contracts in a batch share the same `contractClassId`, artifacts can be shared:

```typescript
// In prepare() phase of RegisterContractOperation:
if (artifact) {
  const contractClass = await getContractClassFromArtifact(artifact);
  // Prime the cache so later operations can use it for display
  this.decodingCache.cacheArtifactForBatch(contractClass.id, artifact);
}

// Later operation with same contractClassId:
const contractName = await this.decodingCache.resolveContractName(
  instance,
  undefined, // No artifact provided
  contractAddress,
);
// This will find the artifact via instance.currentContractClassId
```

**Contract Name Resolution Flow**:

1. Check if artifact provided directly → use `artifact.name`
2. Check instanceCache → get instance → check artifactCache for `instance.currentContractClassId`
3. Query PXE for contract instance
4. Query PXE for contract artifact using `contractClassId`
5. Check addressAliasCache for custom alias
6. Return shortened address (BUT DON'T CACHE IT)

**Critical Rule**: Only cache successfully resolved data. Never cache fallback values or they will prevent future resolution when the real data becomes available.

**Files**:

- `app/src/wallet/decoding/decoding-cache.ts`: Core implementation
- `app/src/wallet/operations/register-contract-operation.ts:130-145`: Batch caching example

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

### ExternalOperation Pattern

All authorization-requiring operations extend `ExternalOperation` with a consistent 3-phase pattern:

**Phase 1: Check** (optional early return)

```typescript
async check(...args): Promise<ResultType | undefined> {
  // Check if operation can be completed without authorization
  // Return result for early exit, or undefined to continue
  const existing = await this.pxe.getSomething();
  if (existing) return existing;  // Early return
  return undefined;  // Continue to prepare phase
}
```

**Phase 2: Prepare** (build display data and execution data)

```typescript
async prepare(...args): Promise<PrepareResult<Result, Display, Execution>> {
  // Query necessary data
  // Build display data for authorization UI
  // Build execution data for execute phase
  // Optionally specify persistence config

  return {
    displayData: { /* data shown to user */ },
    executionData: { /* data needed for execution */ },
    persistence: { storageKey: "...", persistData: ... }  // optional
  };
}
```

**Phase 3: Request Authorization** (show to user)

```typescript
async requestAuthorization(displayData, persistence?) {
  await this.emitProgress("REQUESTING AUTHORIZATION", ...);
  await this.authorizationManager.requestAuthorization([{
    id: crypto.randomUUID(),
    appId: this.authorizationManager.appId,
    method: "methodName",
    params: displayData,
    timestamp: Date.now(),
    persistence,  // If provided, user can grant persistent authorization
  }]);
}
```

**Phase 4: Execute** (perform operation)

```typescript
async execute(executionData): Promise<ResultType> {
  // Perform the actual operation
  const result = await this.pxe.doSomething(executionData);
  await this.emitProgress("SUCCESS", undefined, true);
  return result;
}
```

**Key Principles**:

- Prepare phase must be side-effect free (user might deny)
- Never persist to PXE during prepare - only during execute
- Can cache in-memory for batch operations (see DecodingCache)
- Display data should be serializable for authorization UI
- Execution data can contain complex objects for internal use

**Files**:

- `app/src/wallet/operations/base-operation.ts`: Base class
- `app/src/wallet/operations/*.ts`: All operation implementations

## UI Components

### Authorization Dialogs

- `AuthorizeSendTxContent.tsx`: Send transaction authorization
- `AuthorizeSimulateTxContent.tsx`: Simulation authorization
- Display fee payer and MulticallEntrypoint alerts

### Interaction Type Display

**File**: `app/src/ui/components/sections/interactions/index.tsx`

All interaction types must have:

1. **Label**: Human-readable string in `labels` record
2. **Color**: Semantic hex color in `colors` record
3. **Filter entry**: Included in `allInteractionTypes` array

**Semantic Colors**:

- Green (`#4caf50`): Data access operations (getAccounts, getAddressBook)
- Red (`#f44336`): Security-critical operations (createAuthWit)
- Orange (`#ff9800`): Privacy-sensitive operations (getPrivateEvents)
- Light Blue (`#03a9f4`): Metadata queries (getContractMetadata, getContractClassMetadata)
- Purple (`#9c27b0`): Transaction operations (sendTx, simulateTx)
- Blue (`#2196f3`): Account operations (createAccount)

**Important**: When adding new interaction types, update ALL three locations:

- `labels` record
- `colors` record
- `allInteractionTypes` array

Also update `App.tsx` initial `selectedInteractionTypes` state to include the new type.

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

Test artifact sharing in batch contract registration:

- Register 3 contracts where contracts 2 and 3 share the same `contractClassId`
- Contract 2 provides artifact, contract 3 omits it
- Contract 3 authorization should show rich info (contract name) from cached artifact

### Execution Trace Performance

- Opening execution trace dialog should be instant
- No delays or multiple decoding cache instantiations

### Contract Name Resolution

After registering a contract:

1. Simulations involving that contract should show the contract name
2. Authorization dialogs should show the contract name
3. Interaction history should display the contract name (not shortened address)

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

### Common Pitfalls to Avoid

1. **Don't cache fallback values**: Only cache successfully resolved data. Caching fallbacks (like shortened addresses) prevents future resolution when real data becomes available.

2. **Don't create duplicate PXE instances**: Each session must have exactly one PXE instance shared across all apps. Multiple instances cause LMDB/Map desynchronization.

3. **Check the right variable**: After fetching data, check the fetched variable, not the input parameter.

   ```typescript
   // WRONG:
   const existing = await fetch();
   if (!input) throw new Error();

   // RIGHT:
   const existing = await fetch();
   if (!existing) throw new Error();
   ```

4. **Don't persist during prepare phase**: The prepare phase must be side-effect free since the user might deny authorization. Only persist during execute phase.

5. **Don't reuse authorization for different contexts**: Internal operations (like auth witness creation during sendTx) should use separate code paths from external operations, even if they do the same thing.

6. **Update all interaction type registries**: When adding a new interaction type, update:
   - `WalletInteractionType` type definition
   - `WalletInteractionSchema` enum array
   - `labels` record in interactions/index.tsx
   - `colors` record in interactions/index.tsx
   - `allInteractionTypes` array in interactions/index.tsx
   - `selectedInteractionTypes` initial state in App.tsx

7. **Preserve Git branch state**: When using git rebase operations, capture and restore branch references to avoid detached HEAD state.

8. **Use correct Chrome extension ID computation**: Compute from manifest public key (stable), not directory path (unstable).

## Known Limitations

1. **Authorization Persistence**: Limited to `appId:method:item` format

## Future Improvements

1. **Account Derivation**: BIP-44 HD wallet support
2. **Hardware Wallets**: Ledger/Trezor integration
3. **Advanced Fee Estimation**: Better gas estimation and fee payment methods

## File Reference

### Critical Files

- `app/src/workers/wallet-worker.ts`: Session and PXE management
- `app/src/wallet/core/external-wallet.ts`: dApp request handling
- `app/src/wallet/core/internal-wallet.ts`: Internal operations
- `app/src/wallet/database/wallet-db.ts`: Persistent storage
- `app/src/wallet/operations/*.ts`: Operation implementations
  - `base-operation.ts`: ExternalOperation base class with 3-phase pattern
  - `register-contract-operation.ts`: Contract registration, batch artifact caching
  - `send-tx-operation.ts`: Transaction sending with internal auth witness creation
  - `create-authwit-operation.ts`: Auth witness creation (requires authorization)
  - `get-accounts-operation.ts`: Account access (privacy-sensitive)
  - `get-address-book-operation.ts`: Address alias access
  - `get-private-events-operation.ts`: Private event queries
  - `get-contract-metadata-operation.ts`: Contract metadata queries
  - `get-contract-class-metadata-operation.ts`: Contract class metadata queries
- `app/src/wallet/decoding/decoding-cache.ts`: Contract metadata resolution and caching
- `app/src/ipc/wallet-internal-interface.ts`: IPC type definitions

### UI Files

- `app/src/ui/components/authorization/*`: Authorization dialogs
- `app/src/ui/components/dialogs/*`: Modals and dialogs
- `app/src/ui/components/shared/*`: Reusable components
- `app/src/ui/components/sections/*`: Main UI sections

### Configuration

- `app/src/config/networks.ts`: Network definitions
- `app/package.json`: Dependencies and scripts
- `app/vite.main.config.ts`: Build configuration, Chrome extension ID computation
- `README.md`: Setup instructions

### Build Configuration

**Chrome Extension ID Computation** (`app/vite.main.config.ts`):

The wallet needs to know the Chrome extension ID at build time to configure CORS and communication channels. The ID is computed from the extension's manifest public key:

```typescript
function computeChromeExtensionId(publicKeyBase64: string): string {
  // Chrome's algorithm:
  // 1. Base64 decode the public key to get DER-encoded data
  // 2. SHA256 hash the DER data
  // 3. Take first 128 bits (16 bytes) as hex
  // 4. Map each hex char (0-f) to letter (a-p)
  const derData = Buffer.from(publicKeyBase64, "base64");
  const hash = createHash("sha256").update(derData).digest("hex");
  const first32Chars = hash.substring(0, 32);
  let result = "";
  for (let i = 0; i < first32Chars.length; i++) {
    const hexChar = first32Chars[i];
    const value = parseInt(hexChar, 16);
    result += String.fromCharCode(97 + value); // a-p
  }
  return result;
}
```

**Critical**: Do NOT compute extension ID from directory path - it changes across environments. Always use the manifest public key from `extension/wxt.config.ts`.

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
