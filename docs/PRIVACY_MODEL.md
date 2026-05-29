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

The SQLite database persists:

- Username.
- Password salt.
- Password verifier.
- Account creation time.
- One active device/session record per account.
- Hashed session tokens, never raw tokens.
- Short-lived session challenge nonces.
- Encrypted backup ciphertext.
- Opaque call/session/push event metadata needed for state and future ringer support.

It does not contain plaintext room keys, messages, files, WebRTC offers/answers, IP addresses, raw session tokens, backup plaintext, or decrypted push endpoints.

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

This hides message contents and WebRTC call setup from the relay, but the relay still sees usernames, delivery timing, payload sizes, and who is messaging whom. A fully malicious server can still interfere with public-key lookup, so this is best-effort E2EE rather than a complete authenticated key-transparency system. The direct-message ECDH identity is separate from the device signing key used for session refresh challenges.

## Session Refresh

Each browser/PWA install has a separate ECDSA P-256 device signing key. The server stores only the public key. Session refresh uses a short-lived server nonce and requires a valid ECDSA signature over the session id and nonce before the server rotates the session token.

The device signing key is not reused for direct messages. Direct messages keep using a separate ECDH keypair.

## Encrypted Backups

Automatic conversation carryover uses an encrypted backup. The browser derives a backup key from the password and lowercase username, stores that derived backup key only on the trusted active device, and uploads only AES-GCM ciphertext to the server.

If the local backup key is missing after reload/session refresh, the app keeps local data, marks backup sync locked, and requires signing in again with the password before restore/upload can continue. Files bytes are excluded from backups; only file-message metadata can be included.

## Local History

Conversation history, saved room keys, direct-message peer keys, and the user's local direct-message identity key are stored in browser storage on that device. The app requests persistent storage for installed PWAs, which helps Android keep the data across app restarts and signout.

Signing out or disconnecting does not delete local history. Browser site-data deletion, storage pressure decisions by the OS/browser, or uninstalling the installed PWA can remove it. Local history improves revisitability but increases device-side exposure if the device or browser profile is compromised.

## PWA Notifications

Notification subscription is intentionally available only after the app is installed as a PWA. The app stores the user's notification preference locally and can show Android PWA notifications for incoming messages and calls while the installed app is running or backgrounded.

This is not remote push delivery while the app is fully closed. True Web Push would require VAPID keys and storing push subscription endpoints on a server, which is a separate privacy tradeoff.

## Calls And Files

Audio and video prefer WebRTC media, which browsers protect with DTLS-SRTP. The preferred path is direct P2P. When trusted/self-hosted TURN is configured, ICE can fall back to relayed candidates automatically; the TURN server relays encrypted WebRTC packets and does not decrypt media. If WebRTC cannot connect, the C app server can relay opaque audio-only `CALL_RELAY` chunks that are encrypted in the browser before sending. The app server still sees usernames, call ids, payload sizes, and timing, but not decrypted audio. Video intentionally does not use custom app-server media chunks; internet video should connect through WebRTC P2P or WebRTC TURN.

Files are transferred over WebRTC data channels. File metadata and chunks are additionally encrypted in the browser with the room file key, then checked with SHA-256 after download. The sender's browser keeps the file only long enough to transfer it; the server never stores file bytes.

By default, the browser is configured with no public STUN/TURN servers in `web/config.js`. That is more private, but peer-to-peer connections may fail across NATs. For worldwide deployment, configure first-party STUN/TURN by setting `ANONCHAT_TURN_SECRET` on the app server; browsers fetch short-lived credentials from `/turn-credentials.json`. TURN improves connectivity but exposes metadata such as participant IPs, timing, and packet sizes to the TURN operator. TURN credentials are visible to browsers, so the server generates credentials with a short expiry from server-side secret material.

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
- Authenticated or rate-limited short-lived TURN credential endpoint if abuse becomes a problem.
- Reproducible builds.
- Memory locking for password material where supported.
