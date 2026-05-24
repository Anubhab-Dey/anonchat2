# Privacy Model

This project is designed around one idea: if the server is breached, there should be very little durable data to steal.

## Server Stores On Disk

- Static web files.
- The server executable.
- The account database, `anonchat.sqlite3` by default.

## Server Keeps In Memory

- Active WebSocket connections.
- Active authenticated connection state.
- Current room membership.
- Short outbound message queues waiting for connected clients.

All runtime connection state disappears when the server stops.

## Server Does Not Store

- Chat history.
- Direct message history.
- Uploaded files.
- WebRTC media.
- WebRTC file chunks.
- WebRTC signaling history.
- Persistent login sessions.
- Access logs.
- Recovery emails.

## Account Database

The SQLite database persists only:

- Username.
- Password salt.
- Password verifier.
- Account creation time.

It does not contain room names, messages, files, WebRTC offers/answers, IP addresses, or session tokens.

When WebCrypto is available, the browser first derives a password proof with PBKDF2-SHA-256 using a username-scoped salt, and the server stores a verifier of that proof. This prevents the server from receiving the raw password in normal HTTPS/localhost use. The proof is still password-equivalent for this app, so TLS and server integrity still matter.

## What A Breach Can Still Expose

During runtime, an attacker with server memory access may see:

- Current usernames.
- Current room names.
- Current peer IDs.
- Password verifiers from the account database.
- Password-equivalent auth proofs during active login requests.
- Active encrypted chat frames waiting in outbound queues.
- Encrypted WebRTC signaling frames.
- Live client IP addresses at the OS/socket layer.

That is still real exposure. The design goal is to avoid long-lived message/file databases and reduce post-breach historical damage.

## Message Encryption

Room messages are encrypted in the browser with AES-GCM. Room keys are derived from the room name plus the room passphrase using PBKDF2-SHA-256.

The room passphrase is never sent to the server. Separate scoped keys are derived for chat messages, WebRTC signaling, and file transfer frames so the same AES-GCM key is not reused across surfaces. If the passphrase is weak, ciphertext captured in flight can be attacked offline.

## Signaling Encryption

WebRTC offers, answers, and ICE candidates are encrypted in the browser with the room signaling key before they are relayed through the C server. The server still sees sender peer IDs, target peer IDs, room membership, payload sizes, and timing, but it does not need plaintext SDP or ICE candidate bodies to route a call.

## Direct Messages

Direct username messages and direct username calls are routed only to currently online users. Each client publishes a browser-generated ECDH public key after login. Senders fetch the recipient's current public key, derive an AES-GCM key in the browser, and send only encrypted direct-message or direct-call signaling payloads through the server.

This hides message contents and WebRTC call setup from the relay, but the relay still sees usernames, delivery timing, payload sizes, and who is messaging whom. A fully malicious server can still interfere with public-key lookup, so this is best-effort E2EE rather than a complete authenticated key-transparency system.

## Local History

Conversation history, saved room keys, direct-message peer keys, and the user's local direct-message identity key are stored in browser storage on that device. The app requests persistent storage for installed PWAs, which helps Android keep the data across app restarts and signout.

Signing out or disconnecting does not delete local history. Browser site-data deletion, storage pressure decisions by the OS/browser, or uninstalling the installed PWA can remove it. Local history improves revisitability but increases device-side exposure if the device or browser profile is compromised.

## PWA Notifications

Notification subscription is intentionally available only after the app is installed as a PWA. The app stores the user's notification preference locally and can show Android PWA notifications for incoming messages and calls while the installed app is running or backgrounded.

This is not remote push delivery while the app is fully closed. True Web Push would require VAPID keys and storing push subscription endpoints on a server, which is a separate privacy tradeoff.

## Calls And Files

Audio and video use peer-to-peer WebRTC media, which browsers protect with DTLS-SRTP. The C server does not receive media packets. Full application-level encoded-frame E2EE is not enabled here because browser support is uneven and unsafe homegrown media transforms can make confidentiality worse.

Files are transferred over WebRTC data channels. File metadata and chunks are additionally encrypted in the browser with the room file key, then checked with SHA-256 after download. The sender's browser keeps the file only long enough to transfer it; the server never stores file bytes.

By default, the browser is configured with no public STUN/TURN servers in `web/config.js`. That is more private, but peer-to-peer connections may fail across NATs. Adding public STUN/TURN improves connectivity but shares metadata with that provider.

## Deployment Rules

- Use HTTPS/WSS outside localhost.
- Do not put this behind a reverse proxy with default access logs enabled.
- Run on infrastructure you control.
- Prefer short-lived rooms and strong room passphrases.
- Treat usernames as pseudonyms, not anonymity.
- Expect peers to be able to save messages, files, and call media.

## Future Hardening

- Persistent accounts with encrypted-at-rest recovery email, still no message storage.
- OPAQUE or another PAKE instead of sending password material over TLS.
- Optional Tor onion service deployment profile.
- Private TURN deployment guide.
- Reproducible builds.
- Memory locking for password material where supported.
