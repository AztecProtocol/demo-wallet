# demo-wallet

An Aztec wallet application that allows dApps to interact with user accounts through a secure interface.

## Architecture

The wallet uses **Native Messaging** for secure communication between the browser extension and the Electron app:

```
┌─────────────────┐      stdio            ┌──────────────────┐     Unix socket      ┌──────────────────┐
│ Browser         │ ←──(length-prefix)──→ │ Native Host      │ ←──(newline JSON)──→ │ Electron App     │
│ Extension       │      JSON             │ (compiled binary)│                      │ (wallet-worker)  │
└─────────────────┘                       └──────────────────┘                      └──────────────────┘
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

### Loading the Extension Manually

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

---

## Native Messaging Reference

The native messaging system requires three components:

1. **Native Host Binary** - The executable that bridges extension ↔ Electron
2. **Native Messaging Manifest** - JSON file that tells the browser where to find the native host
3. **IPC Socket** - Communication channel between native host and Electron app

### How Manifest Installation Works

**In Production**: The Electron app automatically installs manifests to user-level locations on startup via `installNativeMessagingManifests()` in [native-messaging.ts](app/src/native-messaging.ts).

**In Development (WXT)**: Chrome runs with a custom `--user-data-dir` and only checks **system-wide** locations. You must manually install the manifest to the system-wide path (requires `sudo`).

---

## macOS

### Native Host Binary

| Environment | Path                                                                            |
| ----------- | ------------------------------------------------------------------------------- |
| Development | `app/dist/native-host/darwin-arm64/native-host` (arm64) or `darwin-x64` (Intel) |
| Production  | Inside app bundle: `AztecKeychain.app/Contents/Resources/native-host`           |

### IPC Socket

| Environment | Path                     |
| ----------- | ------------------------ |
| All         | `~/keychain/wallet.sock` |

### Chrome / Chromium Manifest

| Environment           | Path                                                                                       | Installed By    |
| --------------------- | ------------------------------------------------------------------------------------------ | --------------- |
| Development (WXT)     | `/Library/Google/Chrome/NativeMessagingHosts/com.aztec.keychain.json`                      | Manual (`sudo`) |
| Production            | `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.aztec.keychain.json` | App (auto)      |
| Production (Chromium) | `~/Library/Application Support/Chromium/NativeMessagingHosts/com.aztec.keychain.json`      | App (auto)      |

### Firefox Manifest

| Environment | Path                                                                                 | Installed By |
| ----------- | ------------------------------------------------------------------------------------ | ------------ |
| All         | `~/Library/Application Support/Mozilla/NativeMessagingHosts/com.aztec.keychain.json` | App (auto)   |

### Debug Logs

| Component    | Path                                  |
| ------------ | ------------------------------------- |
| Electron App | `~/keychain/aztec-keychain-debug.log` |
| Native Host  | `~/keychain/native-host.log`          |

### Dev Mode Setup (macOS + Chrome)

Since WXT uses a custom Chrome profile, you must install the manifest system-wide:

```bash
sudo mkdir -p /Library/Google/Chrome/NativeMessagingHosts
sudo tee /Library/Google/Chrome/NativeMessagingHosts/com.aztec.keychain.json << 'EOF'
{
  "name": "com.aztec.keychain",
  "description": "Aztec Keychain Native Messaging Host",
  "path": "/absolute/path/to/demo-wallet/app/dist/native-host/darwin-arm64/native-host",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://<EXTENSION_ID>/"]
}
EOF
```

Replace:

- `/absolute/path/to/demo-wallet` with your actual repo path
- `<EXTENSION_ID>` with your extension's ID (shown in `chrome://extensions`)

---

## Linux

### Native Host Binary

| Environment | Path                                                                 |
| ----------- | -------------------------------------------------------------------- |
| Development | `app/dist/native-host/linux-x64/native-host`                         |
| Production  | Packaged location (e.g., `/opt/AztecKeychain/resources/native-host`) |

### IPC Socket

| Environment | Path                     |
| ----------- | ------------------------ |
| All         | `~/keychain/wallet.sock` |

### Chrome / Chromium Manifest

| Environment           | Path                                                                   | Installed By    |
| --------------------- | ---------------------------------------------------------------------- | --------------- |
| Development (WXT)     | `/etc/opt/chrome/native-messaging-hosts/com.aztec.keychain.json`       | Manual (`sudo`) |
| Production (Chrome)   | `~/.config/google-chrome/NativeMessagingHosts/com.aztec.keychain.json` | App (auto)      |
| Production (Chromium) | `~/.config/chromium/NativeMessagingHosts/com.aztec.keychain.json`      | App (auto)      |

### Firefox Manifest

| Environment | Path                                                        | Installed By |
| ----------- | ----------------------------------------------------------- | ------------ |
| All         | `~/.mozilla/native-messaging-hosts/com.aztec.keychain.json` | App (auto)   |

### Debug Logs

| Component    | Path                                  |
| ------------ | ------------------------------------- |
| Electron App | `~/keychain/aztec-keychain-debug.log` |
| Native Host  | `~/keychain/native-host.log`          |

### Dev Mode Setup (Linux + Chrome)

```bash
sudo mkdir -p /etc/opt/chrome/native-messaging-hosts
sudo tee /etc/opt/chrome/native-messaging-hosts/com.aztec.keychain.json << 'EOF'
{
  "name": "com.aztec.keychain",
  "description": "Aztec Keychain Native Messaging Host",
  "path": "/absolute/path/to/demo-wallet/app/dist/native-host/linux-x64/native-host",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://<EXTENSION_ID>/"]
}
EOF
```

---

## Windows

### Native Host Binary

| Environment | Path                                             |
| ----------- | ------------------------------------------------ |
| Development | `app\dist\native-host\win32-x64\native-host.exe` |
| Production  | Inside app installation directory                |

### IPC Socket (Named Pipe)

| Environment | Path                             |
| ----------- | -------------------------------- |
| All         | `\\.\pipe\aztec-keychain-wallet` |

### Chrome Manifest

| Environment | Path                                                   | Installed By |
| ----------- | ------------------------------------------------------ | ------------ |
| All         | `%LOCALAPPDATA%\AztecKeychain\com.aztec.keychain.json` | App (auto)   |

### Firefox Manifest

| Environment | Path                                                   | Installed By |
| ----------- | ------------------------------------------------------ | ------------ |
| All         | `%LOCALAPPDATA%\AztecKeychain\com.aztec.keychain.json` | App (auto)   |

### Registry Keys

The app automatically creates these registry keys pointing to the manifest file:

| Browser | Registry Key                                                          |
| ------- | --------------------------------------------------------------------- |
| Chrome  | `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.aztec.keychain` |
| Firefox | `HKCU\Software\Mozilla\NativeMessagingHosts\com.aztec.keychain`       |

### Debug Logs

| Component    | Path                                              |
| ------------ | ------------------------------------------------- |
| Electron App | `%USERPROFILE%\keychain\aztec-keychain-debug.log` |
| Native Host  | `%USERPROFILE%\keychain\native-host.log`          |

---

## Manifest Format Reference

### Chrome Manifest (uses `allowed_origins`)

```json
{
  "name": "com.aztec.keychain",
  "description": "Aztec Keychain Native Messaging Host",
  "path": "/absolute/path/to/native-host",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://EXTENSION_ID/"]
}
```

### Firefox Manifest (uses `allowed_extensions`)

```json
{
  "name": "com.aztec.keychain",
  "description": "Aztec Keychain Native Messaging Host",
  "path": "/absolute/path/to/native-host",
  "type": "stdio",
  "allowed_extensions": ["aztec-keychain@aztec.network"]
}
```

---

## Production Usage

### Note for Mac users

After downloading a release, run:

```bash
xattr -d com.apple.quarantine ./AztecKeychain.app
```

To avoid the "this app is damaged" message.

---

## Troubleshooting

### Extension shows "Wallet backend not connected"

1. Ensure the Electron app is running
2. Check `~/keychain/native-host.log` for connection errors
3. Verify the manifest is installed correctly for your browser
4. Confirm the extension ID in the manifest matches your installed extension

### Native host fails to start

1. Ensure the native host binary exists and is executable (`chmod +x native-host`)
2. Check that the manifest `path` points to the correct binary location
3. On macOS, you may need to allow the binary in System Preferences > Security & Privacy

### WXT dev mode can't connect (Chrome)

In dev mode, Chrome uses a custom `--user-data-dir` and only checks **system-wide** manifest locations:

- macOS: `/Library/Google/Chrome/NativeMessagingHosts/`
- Linux: `/etc/opt/chrome/native-messaging-hosts/`

You must manually install the manifest there with `sudo`.

### Manifest not being found

1. Verify the manifest file exists at the expected path
2. Check that the JSON is valid (no syntax errors)
3. Ensure the `path` in the manifest is an absolute path to the native host binary
4. On Windows, verify the registry key exists and points to the manifest file
