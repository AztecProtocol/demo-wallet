# demo-wallet

An Aztec wallet application that allows dApps to interact with user accounts through a secure interface.

## Development Setup

### Prerequisites

- Node.js v22
- yarn
- A running Aztec local node (or access to a remote node)

### Running in Development Mode

Follow these steps to run the wallet in development mode:

1. **Install dependencies**

   ```bash
   cd app
   yarn install
   ```

2. **Start the wallet application**

   ```bash
   yarn start
   ```

3. **Install and run the browser extension**

   ⚠️ **Important**: The browser extension must be running for the app to work properly.

   The extension is located at `extension`. To set it up:

   ```bash
   cd extension
   yarn install
   yarn dev
   ```

   This will launch a browser with the extension preloaded

   **Loading the extension in your browser:**

   **For Chromium-based browsers (Chrome, Brave, Edge):**

   1. Open your browser and navigate to the extensions page:
      - Chrome: `chrome://extensions`
      - Brave: `brave://extensions`
      - Edge: `edge://extensions`
   2. Enable "Developer mode" (toggle in the top-right corner)
   3. Click "Load unpacked"
   4. Select the `extension/.output/chrome-mv3-*` directory

   **For Firefox:**

   ```bash
   yarn zip:firefox
   ```

   1. Navigate to `about:debugging#/runtime/this-firefox`
   2. Click "Load Temporary Add-on"
   3. Select the created .zip file under `extension/.output/*`

   The extension provides the interface between dApps and the wallet.

### WebSocket Communication

The wallet currently uses **WebSocket communication** for dApp-to-wallet messaging.

⚠️ **Port Requirements**:

- Ensure port **8765** is available on your machine
- If port 8765 is in use, you'll need to modify the configuration in `app/src/workers/ws-worker.ts`

📝 **Note**: This WebSocket-based communication is temporary. The architecture should ideally use the browser's native extension-to-native-app communication system (Native Messaging API) instead, which would eliminate the need for managing ports and provide better security.

## Production Usage

### Note for Mac users

After downloading a release, run:

```bash
xattr -d com.apple.quarantine ./app.app
```

To avoid the "this app is damaged" message.
