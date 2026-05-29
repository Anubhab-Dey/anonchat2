# Privacy Model

AnonChat2 is designed so the server has as little durable private material as possible while the app remains easy for normal people to use.

## Server Stores

- Static frontend files.
- SQLite anonymous session records.
- Room rows used only to remember that a room exists/recently existed.
- Minimal active call state while a call is being signaled.

## Server Does Not Store

- Plaintext messages.
- Message history.
- Room passwords.
- WebRTC SDP or ICE in plaintext.
- Call media.
- Call recordings.
- Uploaded files.
- Device fingerprints.
- Long-term IP histories.
- Invasive analytics.

## Browser Encryption

Room chat is encrypted in the browser with AES-GCM. The room key is derived from the room name and room password using PBKDF2-SHA-256.

Call signaling is also encrypted in the browser with the room signaling key before it is routed through the backend.

The backend can see live connection metadata, room IDs, participant IDs, encrypted payload sizes, and timing. It cannot decrypt room messages or signaling payloads unless it also learns the room password.

## Sessions

Anonymous sessions use an HttpOnly cookie. Frontend JavaScript receives only the safe participant ID and display name, not the raw session token.

Production requires a strong `SESSION_SECRET`. Development may use local defaults.

## Logs

Backend logs are structured and include:

- request ID
- method
- route
- status
- duration
- coarse remote class

Logs must not include message content, call payloads, raw tokens, TURN credentials, cookies, secrets, or stack traces shown to users.

## Local Device State

The current SvelteKit frontend keeps active chat state in memory. It does not store private message history in IndexedDB by default. This is more private on shared devices, but it is less convenient than the legacy local-history flow.

## Calls

Calls use WebRTC peer-to-peer media first. First-party TURN can relay encrypted WebRTC packets when direct peer-to-peer fails. TURN operators can observe metadata such as IP addresses, packet sizes, and timing, but not decrypted DTLS-SRTP media.

## Remaining Reality

This is private-by-structure, not magic anonymity. A server, VPS provider, browser, peer, or network observer can still observe live metadata. Peers can save messages or record calls outside the app.
