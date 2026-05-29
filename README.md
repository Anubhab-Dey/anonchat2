# AnonChat

AnonChat is a C-first, privacy-minimizing chat prototype.

The server is intentionally boring: it serves the web client, keeps username/password accounts in a tiny SQLite database, relays encrypted frames to currently connected peers, and relays encrypted WebRTC signaling for peer-to-peer calls and file transfer. It does not persist messages, files, sessions, signaling payloads, or access logs.

## Build On Windows

This workspace is set up for MSYS2 UCRT64 on Windows.

```powershell
cmake --preset msys2-ucrt64-debug
cmake --build --preset msys2-ucrt64-debug
```

The Windows build uses BCrypt for random bytes and password verifier derivation.

## Build On Linux

Install the native dependencies first. On Debian/Ubuntu-like systems:

```bash
sudo apt install build-essential cmake libwebsockets-dev libsqlite3-dev libssl-dev
```

Then build:

```bash
cmake --preset linux-debug
cmake --build --preset linux-debug
```

The Linux build uses `getrandom` or `/dev/urandom` for random bytes and OpenSSL libcrypto for PBKDF2-SHA-256.

## Run On Windows

```powershell
.\build\anonchat.exe
```

## Run On Linux

```bash
./build-linux/anonchat
```

Then open:

```text
http://127.0.0.1:8080/
```

Set `ANONCHAT_PORT` before launch to use another port.

Set `ANONCHAT_DB_PATH` before launch to choose where the account database lives. If unset, the server creates `anonchat.sqlite3` in the current working directory.

## Current Features

- Username/password signup and login, email omitted by design for now.
- Client-side password proofing when WebCrypto is available, so the server does not receive the raw password.
- SQLite-backed accounts survive server crashes and restarts.
- Browser-side AES-GCM encrypted room messages using a shared room key.
- Browser-side AES-GCM encrypted WebRTC signaling, so offers, answers, and ICE candidates are opaque to the relay.
- Direct username messaging for online users, encrypted in the browser with per-user ECDH keys.
- Direct username calls for online users, with WebRTC signaling encrypted through the same per-user ECDH path.
- Local conversation history in IndexedDB, so installed PWAs can reopen previous chats after signout or reload.
- PWA-only notification subscription for incoming messages and calls while the installed app is backgrounded.
- Saved room entries can be reopened and renamed from the conversations list.
- Peer-to-peer audio/video calls over WebRTC DTLS-SRTP, with per-peer and room-wide call controls.
- WebRTC data-channel file sharing with browser-side AES-GCM encrypted metadata/chunks and SHA-256 verification after download.
- Invite links with room keys kept in the URL fragment.
- Installable PWA shell for desktop and mobile browsers.
- No request logging, no message database, no file storage, no persistent sessions.

## Internet Calls

The default browser config uses no third-party ICE servers:

```js
window.ANONCHAT_CONFIG = {
  iceServers: [],
  turnCredentialUrl: "/turn-credentials.json",
  relayFallbackEnabled: true,
  backendRelayFallbackEnabled: true,
  callTransport: "p2p_first",
  turnRequiredForFallback: true
};
```

That is more private, but direct peer-to-peer WebRTC may only work on the same machine or LAN. The call order is direct WebRTC first, then relay-only WebRTC through a configured first-party TURN server, then the app server's opaque audio-only `CALL_RELAY` fallback. TURN relays encrypted DTLS-SRTP packets and does not decrypt call media. The app server fallback relays browser-encrypted audio chunks and also does not decrypt call audio.

For reliable internet video calls, deploy a first-party TURN server such as coturn and set `ANONCHAT_TURN_SECRET` on the app server. The browser fetches short-lived TURN credentials from `/turn-credentials.json`; start from [web/local-config.example.js](web/local-config.example.js) and [ops/coturn/README.md](ops/coturn/README.md). Without TURN, calls can still fall back to the encrypted app-server audio relay after both sides accept the call, but that path is audio-only by design. Video stays on WebRTC P2P or WebRTC TURN so the browser keeps the media protected with DTLS-SRTP end to end.

## Important Limits

This is not magic anonymity. A server or network observer can still see live TCP connections, source IPs, room names, usernames, peer IDs, and encrypted payload sizes/timing. WebRTC peers can learn each other's network addresses. For internet deployment, use HTTPS/WSS, consider Tor/VPN access patterns, and host your own STUN/TURN if you need NAT traversal.

Existing local test accounts created before the password-proof change may need to be recreated.

Local conversation history is stored on the user's device, not the server. Signing out or losing the WebSocket connection does not erase it. Browser site-data deletion or uninstalling the installed PWA can remove it.

Read [docs/PRIVACY_MODEL.md](docs/PRIVACY_MODEL.md) before trusting this with anything sensitive.
