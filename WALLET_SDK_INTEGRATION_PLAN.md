# Wallet SDK Integration Plan for Demo Wallet

## Overview

This document outlines the plan to integrate the demo-wallet with the `@aztec/wallet-sdk` extension provider protocol. The wallet extension will respond to discovery requests from dApps that include specific chain information, only responding if it supports that network based on the existing `app/src/config/networks.ts` whitelist.

## Quick Implementation Summary

**Files to Modify:**
1. `extension/entrypoints/content.ts` - Add discovery message handling
2. `extension/entrypoints/background.ts` - Add network support checking with caching
3. `app/src/workers/ws-worker.ts` - Forward network check messages (minimal changes)
4. `app/src/workers/wallet-worker.ts` - Add network support validation using `getNetworkByChainId`

**Network Whitelist:**
- Uses existing `app/src/config/networks.ts` with `NETWORKS` array
- Current networks: Localhost (31337) and Devnet (11155111)
- Network validation via `getNetworkByChainId(chainId, version)` helper

**Discovery Flow:**
1. dApp sends discovery message with chainInfo (chainId, version)
2. Content script asks background script to validate network
3. Background script queries wallet worker via WebSocket
4. Wallet worker checks chainInfo against networks whitelist
5. Extension responds ONLY if network is supported

## Architecture: Request-Based Discovery

The SDK uses a **request-based** approach:

1. **dApp requests wallets FOR a specific chain/version** via `WalletManager.getAvailableWallets({ chainInfo })`
2. **SDK broadcasts discovery message WITH chainInfo** to all extensions
3. **Extensions respond ONLY if they support that specific chain/version**
4. **dApp receives only compatible wallets**

This means:
- Extensions don't broadcast what they support
- Extensions receive chainInfo in discovery message
- Extensions check if they can handle that network before responding
- No need to store or configure supported networks - it's determined dynamically

## Current Architecture

### Message Flow
```
dApp (WalletManager)
  ↓ window.postMessage (with chainInfo)
Content Script (content.ts)
  [Checks if wallet supports chainInfo]
  ↓ window.postMessage (response)
dApp (receives compatible wallet)

Later, when calling wallet methods:
dApp (ExtensionWallet)
  ↓ window.postMessage (wallet method with chainInfo)
Content Script (content.ts)
  ↓ browser.runtime.sendMessage
Background Script (background.ts)
  ↓ WebSocket (port 8765)
WS Worker (ws-worker.ts)
  ↓ MessagePort
Wallet Worker (wallet-worker.ts)
  ↓ PXE Operations
```

### Key Architectural Constraints
- **Single PXE Per Session**: Each network session (chainId-version) has ONE shared PXE instance used by all apps
- **Chain Info in Messages**: Chain information is embedded in every wallet method call for session routing
- **Discovery is Validation**: Extension checks if it can support the requested chain during discovery

## Message Protocols

### 1. Discovery Protocol

**Discovery Request** (from dApp via SDK):
```typescript
{
  type: 'aztec-wallet-discovery',
  requestId: string,
  chainInfo: {
    chainId: Fr,    // e.g., Fr(31337) for local devnet
    version: Fr     // e.g., Fr(1) for protocol version 1
  }
}
```

**Discovery Response** (from wallet extension - ONLY if supported):
```typescript
{
  type: 'aztec-wallet-discovery-response',
  requestId: string,
  extensionInfo: {
    id: string,        // Unique extension ID
    name: string,      // Display name
    icon?: string,     // Icon URL
    version: string    // Extension version
  }
}
```

**Note**: Extensions should NOT respond if they don't support the requested chainInfo.

### 2. Wallet Method Protocol (Existing)

**Request**:
```typescript
{
  type: keyof FunctionsOf<Wallet>,  // e.g., 'getAccounts', 'signTransaction'
  args: unknown[],
  messageId: string,
  chainInfo: {
    chainId: Fr,
    version: Fr
  },
  appId: string,
  extensionId?: string
}
```

**Response**:
```typescript
{
  messageId: string,
  result?: unknown,
  error?: unknown,
  extensionId: string
}
```

## Implementation Plan

### Phase 1: Update Content Script for Discovery

**File**: `extension/entrypoints/content.ts`

The content script needs to:
1. Intercept discovery messages
2. Check if the wallet supports the requested chainInfo
3. Respond immediately if supported (no WebSocket roundtrip needed for discovery)
4. Forward wallet method calls to background script as before

```typescript
export default defineContentScript({
  matches: ["*://*/*"],
  main() {
    // Handle discovery requests immediately
    window.addEventListener("message", async (event) => {
      if (event.source !== window) {
        return;
      }

      const { data } = event;

      // Handle discovery request
      if (data.type === 'aztec-wallet-discovery') {
        const { requestId, chainInfo } = data;

        // Check if wallet supports this chain/version
        const isSupported = await browser.runtime.sendMessage({
          type: 'check_network_support',
          chainInfo
        });

        if (isSupported) {
          window.postMessage({
            type: 'aztec-wallet-discovery-response',
            requestId,
            extensionInfo: {
              id: 'demo-wallet-extension',
              name: 'Demo Wallet',
              icon: browser.runtime.getURL('icon/128.png'),
              version: browser.runtime.getManifest().version
            }
          }, '*');
        }
        // If not supported, don't respond at all
        return;
      }

      // Handle wallet method calls (existing logic)
      if (data.result || data.error) {
        return;
      }

      const { data: content } = event;
      browser.runtime.sendMessage({ origin: "injected", content });
    });

    // Existing listener for responses from background
    browser.runtime.onMessage.addListener((event: any) => {
      const { content, origin } = event;
      if (origin !== "background") {
        return;
      }
      window.postMessage(content, '*');
    });
  },
});
```

### Phase 2: Update Background Script for Network Check

**File**: `extension/entrypoints/background.ts`

The background script needs to:
1. Handle `check_network_support` messages from content script
2. Query the wallet worker via WebSocket to check if network is supported
3. Cache the result temporarily for performance

```typescript
export default defineBackground(() => {
  let webSocket: WebSocket | null = null;
  let networkCheckCache = new Map<string, Promise<boolean>>();

  // Handle messages from content script
  browser.runtime.onMessage.addListener(async (event: any, sender, sendResponse) => {
    const { content, origin, type, chainInfo } = event;

    // Handle network support check from content script
    if (type === 'check_network_support') {
      const cacheKey = `${chainInfo.chainId.toString()}-${chainInfo.version.toString()}`;

      // Return cached result if available and recent
      if (networkCheckCache.has(cacheKey)) {
        return networkCheckCache.get(cacheKey);
      }

      // Check with wallet worker
      const checkPromise = new Promise<boolean>((resolve) => {
        if (!webSocket || webSocket.readyState !== WebSocket.OPEN) {
          resolve(false);
          return;
        }

        const messageId = crypto.randomUUID();
        const timeout = setTimeout(() => {
          resolve(false);
          pendingNetworkChecks.delete(messageId);
        }, 500); // 500ms timeout for network check

        pendingNetworkChecks.set(messageId, { resolve, timeout });

        webSocket.send(JSON.stringify({
          type: '__check_network_support',
          messageId,
          chainInfo
        }));
      });

      // Cache for 5 seconds
      networkCheckCache.set(cacheKey, checkPromise);
      setTimeout(() => networkCheckCache.delete(cacheKey), 5000);

      return checkPromise;
    }

    // Handle wallet method calls
    if (webSocket && origin === "injected") {
      webSocket.send(content);
    }
  });

  const pendingNetworkChecks = new Map<string, { resolve: (value: boolean) => void; timeout: NodeJS.Timeout }>();

  function connect() {
    return new Promise((resolve, reject) => {
      webSocket = new WebSocket("ws://localhost:8765");

      webSocket.onopen = () => {
        console.log("websocket open");
        keepAlive();
        resolve(true);
      };

      webSocket.onmessage = async (event) => {
        const data = JSON.parse(event.data);

        // Handle network support check response
        if (data.type === '__network_support_response') {
          const pending = pendingNetworkChecks.get(data.messageId);
          if (pending) {
            clearTimeout(pending.timeout);
            pending.resolve(data.result === true);
            pendingNetworkChecks.delete(data.messageId);
          }
          return;
        }

        // Forward wallet method responses to content script
        const [tab] = await browser.tabs.query({
          active: true,
          currentWindow: true,
        });
        if (!tab?.id) {
          console.error("No active tab found");
          return;
        }
        browser.tabs.sendMessage(tab.id, {
          origin: "background",
          content: data,
        });
      };

      webSocket.onclose = (event) => {
        console.log("websocket connection closed");
        webSocket = null;
        networkCheckCache.clear();
        pendingNetworkChecks.forEach(({ timeout }) => clearTimeout(timeout));
        pendingNetworkChecks.clear();
        connect();
      };
    });
  }

  // ... rest of existing code (keepAlive, etc.)
});
```

### Phase 3: Update WS Worker to Forward Network Checks

**File**: `app/src/workers/ws-worker.ts`

The WS worker simply forwards the network check message:

```typescript
async function main() {
  const app = express();
  app.use(cors());
  app.use(json());

  const server = createServer(app);
  const wss = new WebSocketServer({ server });

  let externalPort: MessagePortMain;

  const handleWalletEvent = (event: any) => {
    const { origin, content } = event.data;
    if (origin !== "wallet") {
      return;
    }
    wss.clients.forEach((client) => client.send(content));
  };

  wss.on("connection", (ws) => {
    ws.on("message", (data) => {
      if (data.toString() === "keepalive") {
        return;
      }

      // Forward all messages (including network checks) to wallet worker
      externalPort.postMessage({
        origin: "websocket",
        content: data.toString("utf-8"),
      });
    });
  });

  await server.listen(8765);
}
```

### Phase 4: Update Wallet Worker to Handle Network Checks

**File**: `app/src/workers/wallet-worker.ts`

Add handler for the special `__check_network_support` message type using the existing networks configuration:

```typescript
import { getNetworkByChainId } from '../config/networks.js';

externalPort.on("message", async (event) => {
  const { origin, content } = event.data;
  if (origin !== "websocket") {
    return;
  }

  let messageContent = JSON.parse(content);
  const { type, messageId, args, appId, chainInfo } = messageContent;

  // Handle network support check
  if (type === '__check_network_support') {
    try {
      // Parse the chain info
      const parsedChainInfo = ChainInfoSchema.parse(chainInfo);

      // Check against the networks whitelist
      const chainIdNum = parsedChainInfo.chainId.toNumber();
      const versionNum = parsedChainInfo.version.toNumber();

      const network = getNetworkByChainId(chainIdNum, versionNum);
      const isSupported = network !== undefined;

      externalPort.postMessage({
        origin: "wallet",
        content: JSON.stringify({
          type: '__network_support_response',
          messageId,
          result: isSupported
        })
      });
    } catch (error) {
      // If we can't parse the chain info, we don't support it
      externalPort.postMessage({
        origin: "wallet",
        content: JSON.stringify({
          type: '__network_support_response',
          messageId,
          result: false
        })
      });
    }
    return;
  }

  // Existing wallet method handling
  const parsedChainInfo = ChainInfoSchema.parse(chainInfo);
  const wallets = await init(parsedChainInfo, appId, internalPort, logPort);

  handleEvent(externalPort, wallets.external, WalletSchema, type, messageId, args, userLog);
});
```

**Key Implementation Details**:
- Import `getNetworkByChainId` from existing networks configuration
- Convert `Fr` values to numbers using `.toNumber()`
- Use existing helper to check if network is in whitelist
- Return `true` only if network is found in `NETWORKS` array
- The existing `networks.ts` handles version auto-detection (version 0)

## Testing Plan

### 1. Discovery Testing

**Test**: Extension responds only to whitelisted networks
```typescript
// In browser console on any page

// Test with Localhost network (chainId: 31337, version: 0)
window.postMessage({
  type: 'aztec-wallet-discovery',
  requestId: 'test-localhost',
  chainInfo: {
    chainId: { value: 31337n }, // Fr representation
    version: { value: 0n }
  }
}, '*');

// Listen for response
window.addEventListener('message', (event) => {
  if (event.data.type === 'aztec-wallet-discovery-response') {
    console.log('Discovery response:', event.data);
  }
});

// Test with Devnet network (chainId: 11155111, version: 1667575857)
window.postMessage({
  type: 'aztec-wallet-discovery',
  requestId: 'test-devnet',
  chainInfo: {
    chainId: { value: 11155111n },
    version: { value: 1667575857n }
  }
}, '*');

// Test with unsupported network (should NOT respond)
window.postMessage({
  type: 'aztec-wallet-discovery',
  requestId: 'test-unsupported',
  chainInfo: {
    chainId: { value: 99999n },
    version: { value: 1n }
  }
}, '*');
```

**Expected**:
- Should receive response for Localhost (31337) within 500ms
- Should receive response for Devnet (11155111) within 500ms
- Should NOT receive response for unsupported network (99999)

### 2. SDK Integration Testing

**Test**: WalletManager discovers extension for supported network
```typescript
// Using the Wallet SDK in playground
const manager = WalletManager.configure({
  extensions: { enabled: true }
});

const wallets = await manager.getAvailableWallets({
  chainInfo: {
    chainId: new Fr(31337),
    version: new Fr(1)
  },
  timeout: 1000
});

console.log('Discovered wallets:', wallets);

// Test with unsupported network
const noWallets = await manager.getAvailableWallets({
  chainInfo: {
    chainId: new Fr(99999),
    version: new Fr(99)
  },
  timeout: 1000
});

console.log('Unsupported network wallets:', noWallets);
```

**Expected**:
- Should discover demo wallet for supported network
- Should NOT discover demo wallet for unsupported network

### 3. Wallet Method Testing

**Test**: Wallet methods work after discovery
```typescript
// Connect and test getAccounts
const wallet = await wallets[0].connect('test-app');
const accounts = await wallet.getAccounts();
console.log('Accounts:', accounts);

// Test other wallet methods
const address = accounts[0];
const balance = await wallet.getBalance(address);
console.log('Balance:', balance);
```

**Expected**: All wallet methods should work correctly with chainInfo baked in.

### 4. Multi-Network Testing

**Test**: Wallet correctly handles multiple network sessions
```typescript
// Create two wallet instances with different chain info
const manager = WalletManager.configure({ extensions: { enabled: true } });

const wallets1 = await manager.getAvailableWallets({
  chainInfo: { chainId: new Fr(31337), version: new Fr(1) },
  timeout: 1000
});

const wallets2 = await manager.getAvailableWallets({
  chainInfo: { chainId: new Fr(12345), version: new Fr(2) },
  timeout: 1000
});

const wallet1 = await wallets1[0].connect('app1');
const wallet2 = await wallets2[0].connect('app2');

const accounts1 = await wallet1.getAccounts();
const accounts2 = await wallet2.getAccounts();

console.log('Wallet 1 accounts:', accounts1);
console.log('Wallet 2 accounts:', accounts2);
```

**Expected**: Each wallet maintains its own session without LMDB conflicts.

## Migration Notes

### After Nightly Build

1. **Copy Extension Implementation**: Copy the extension implementation from `demo-wallet/extension/` to `aztec-packages/` as a reference implementation.

2. **Update Documentation**: Add the demo wallet extension as an example in the wallet-sdk documentation.

3. **Clean Up Demo Wallet**: Remove the temporary implementation and switch to using the released wallet-sdk package.

### Breaking Changes

None. The integration is purely additive:
- Wallet interface unchanged
- Existing wallet methods continue to work
- Discovery is a new feature at the extension level

### Dependencies

The extension will need types from `@aztec/wallet-sdk`:
- Use type-only imports to avoid runtime dependencies
- Or include minimal type definitions in extension code

```typescript
// Option 1: Type-only import (no runtime dependency)
import type { ExtensionDiscoveryMessage } from '@aztec/wallet-sdk/providers/extension';

// Option 2: Local type definitions
type ExtensionDiscoveryMessage = {
  type: 'aztec-wallet-discovery';
  requestId: string;
  chainInfo: { chainId: Fr; version: Fr };
};
```

## Implementation Strategy

Since npm linking is difficult:

1. **Implement in demo-wallet first** (this repo)
2. **Test thoroughly** with the playground
3. **Wait for nightly build** with the updated wallet-sdk
4. **Copy to aztec-packages** as reference implementation
5. **Clean up demo-wallet** after migration

## Network Support Strategy

We will use **Option 1: Explicit Whitelist** using the existing `app/src/config/networks.ts` configuration file.

The existing networks configuration at `app/src/config/networks.ts` defines:
- `NETWORKS`: Array of `NetworkConfig` with `chainId` and `version` fields
- `getNetworkByChainId(chainId, version)`: Helper to check if a network is supported

The extension will:
1. Import the networks configuration
2. Check incoming discovery requests against the whitelist
3. Only respond if the chainId/version pair is in `NETWORKS`

**Benefits**:
- Clear, secure, explicit control over supported networks
- Centralized configuration already used by the wallet
- Easy to add/remove networks
- No risk of responding to unsupported networks

## Security Considerations

1. **Origin Validation**: Content script validates `event.source === window`
2. **Extension ID**: Background script includes extension ID in all responses
3. **Timeout Handling**: Network checks timeout after 500ms to prevent hanging
4. **Error Handling**: All errors are caught and logged without exposing sensitive information
5. **No Response on Failure**: If network is unsupported, extension doesn't respond (fails silently)

## Open Questions

1. Should the wallet worker attempt to validate network support, or always return true?
2. Should network check results be cached, and for how long?
3. Should there be a configuration file for supported networks, or should it be dynamic?

**Recommendation**: Start with dynamic support (always return true), then add explicit network configuration if needed based on feedback.

## References

- Wallet SDK Extension Provider: `yarn-project/wallet-sdk/src/providers/extension/`
- Demo Wallet Architecture: `~/repos/demo-wallet/CLAUDE.md`
- Current Extension: `~/repos/demo-wallet/extension/entrypoints/`
- Wallet Worker: `~/repos/demo-wallet/app/src/workers/wallet-worker.ts`
