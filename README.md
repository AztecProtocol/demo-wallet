# demo-wallet

An Aztec wallet application that allows dApps to interact with user accounts through a secure interface.

## Architecture

The wallet uses **Native Messaging** for secure communication between the browser extension and the Electron app:

```
┌─────────────────┐      stdio        ┌──────────────────┐     Unix socket     ┌──────────────────┐
│ Browser         │ ←──(length-prefix)──→ │ Native Host     │ ←──(newline JSON)──→ │ Electron App     │
│ Extension       │      JSON         │ (compiled binary) │                     │ (wallet-worker)  │
└─────────────────┘                   └──────────────────┘                     └──────────────────┘
```

- **Browser Extension**: Communicates with dApps via secure encrypted channels (ECDH + AES-GCM)
- **Native Host**: A small binary (`native-host`) that bridges extension ↔ Electron via stdio/socket
- **Electron App**: Runs the wallet-worker process that handles account management and signing

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

2. **Build the native host**

   The native host must be compiled before running the app:

   ```bash
   yarn build:native-host
   ```

3. **Start the wallet application**

   ```bash
   yarn start
   ```

4. **Install and run the browser extension**

   The browser extension must be running for the app to work properly.

   The extension is located at `extension`. To set it up:

   ```bash
   cd extension
   yarn install
   yarn dev
   ```

   This will launch a browser with the extension preloaded.

### Native Messaging Configuration (Dev Mode)

When using WXT dev mode, Chrome runs with a custom `--user-data-dir` and only checks the **system-wide location** for native messaging hosts. The app will print instructions if the manifest is missing, but here's the setup:

#### macOS (Chrome)

Create the manifest at `/Library/Google/Chrome/NativeMessagingHosts/com.aztec.keychain.json`:

```bash
sudo mkdir -p /Library/Google/Chrome/NativeMessagingHosts
sudo tee /Library/Google/Chrome/NativeMessagingHosts/com.aztec.keychain.json << 'EOF'
{
  "name": "com.aztec.keychain",
  "description": "Aztec Keychain Native Messaging Host",
  "path": "/path/to/demo-wallet/app/dist/native-host/darwin-arm64/native-host",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://<EXTENSION_ID>/"]
}
EOF
```

Replace `<EXTENSION_ID>` with your extension's ID (shown in `chrome://extensions`).

#### Linux (Chrome)

Create the manifest at `/etc/opt/chrome/native-messaging-hosts/com.aztec.keychain.json`.

#### Loading the Extension Manually

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

## Native Messaging Paths Reference

The native messaging host and manifests are installed at platform-specific locations.

### Native Host Binary

The compiled native host binary is located at:

- **macOS arm64**: `app/dist/native-host/darwin-arm64/native-host`
- **macOS x64**: `app/dist/native-host/darwin-x64/native-host`
- **Linux x64**: `app/dist/native-host/linux-x64/native-host`
- **Windows x64**: `app/dist/native-host/win32-x64/native-host.exe`

### IPC Socket

The native host connects to the Electron app via a socket:

| Platform | Socket Path |
|----------|-------------|
| macOS    | `~/keychain/wallet.sock` |
| Linux    | `~/keychain/wallet.sock` |
| Windows  | `\\.\pipe\aztec-keychain-wallet` |

### Native Messaging Manifest Locations

The app automatically installs manifests on startup to these locations:

#### Firefox

| Platform | Manifest Path |
|----------|--------------|
| macOS    | `~/Library/Application Support/Mozilla/NativeMessagingHosts/com.aztec.keychain.json` |
| Linux    | `~/.mozilla/native-messaging-hosts/com.aztec.keychain.json` |
| Windows  | `%LOCALAPPDATA%\AztecKeychain\com.aztec.keychain.json` (+ registry key) |

#### Chrome / Chromium

| Platform | Manifest Path |
|----------|--------------|
| macOS (user)   | `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.aztec.keychain.json` |
| macOS (system) | `/Library/Google/Chrome/NativeMessagingHosts/com.aztec.keychain.json` |
| Linux (user)   | `~/.config/google-chrome/NativeMessagingHosts/com.aztec.keychain.json` |
| Linux (system) | `/etc/opt/chrome/native-messaging-hosts/com.aztec.keychain.json` |
| Windows        | `%LOCALAPPDATA%\AztecKeychain\com.aztec.keychain.json` (+ registry key) |

#### Windows Registry Keys

On Windows, the following registry keys are created to point to the manifest files:

- **Firefox**: `HKCU\Software\Mozilla\NativeMessagingHosts\com.aztec.keychain`
- **Chrome**: `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.aztec.keychain`

### Manifest Format

**Chrome manifest** (`allowed_origins`):
```json
{
  "name": "com.aztec.keychain",
  "description": "Aztec Keychain Native Messaging Host",
  "path": "/absolute/path/to/native-host",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://EXTENSION_ID/"]
}
```

**Firefox manifest** (`allowed_extensions`):
```json
{
  "name": "com.aztec.keychain",
  "description": "Aztec Keychain Native Messaging Host",
  "path": "/absolute/path/to/native-host",
  "type": "stdio",
  "allowed_extensions": ["aztec-keychain@aztec.network"]
}
```

### Debug Logs

Log files for troubleshooting are written to:

| Component | Log Path |
|-----------|----------|
| Electron App | `~/keychain/aztec-keychain-debug.log` |
| Native Host | `~/keychain/native-host.log` |

## Production Usage

### Note for Mac users

After downloading a release, run:

```bash
xattr -d com.apple.quarantine ./app.app
```

To avoid the "this app is damaged" message.

## Troubleshooting

### Extension shows "Wallet backend not connected"

1. Ensure the Electron app is running
2. Check `~/keychain/native-host.log` for connection errors
3. Verify the manifest is installed correctly for your browser
4. Confirm the extension ID in the manifest matches your installed extension

### Native host fails to start

1. Ensure the native host binary exists and is executable
2. Check that the manifest `path` points to the correct binary location
3. On macOS, you may need to allow the binary in System Preferences > Security & Privacy

### WXT dev mode can't connect

In dev mode, Chrome uses a custom user-data-dir and only checks system-wide manifest locations. Install the manifest to `/Library/Google/Chrome/NativeMessagingHosts/` (macOS) or `/etc/opt/chrome/native-messaging-hosts/` (Linux).
