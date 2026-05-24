# Deferred Implementation Notes

These notes capture intentionally deferred security-sensitive work so the next pass can continue without redesigning the current data model or protocol.

## Call Relay Media

Current state:
- The backend has `CALL_INVITE`, `CALL_ACCEPT`, `CALL_DECLINE`, `CALL_END`, and `CALL_RELAY`.
- The server stores call events and routes only opaque encrypted payloads/frames.
- The frontend has a unified call session state, P2P-first transport selection, and automatic relay fallback state.
- Relay fallback does not pretend media is complete; it fails closed after establishing the relay path.

Next pass:
1. Add browser media frame production for relay transport using WebRTC encoded transforms where available, with a WebCodecs/MediaStreamTrackProcessor fallback only if it can be kept reliable.
2. Encrypt every audio/video relay frame in the browser before `CALL_RELAY` with the existing direct ECDH key for direct calls or the room relay key for room calls.
3. Sequence frames per call participant and drop/reorder safely on the receiver.
4. Decode/play decrypted frames locally; never send plaintext media to the server.
5. Keep P2P as the preferred selected transport and avoid switching back from relay to P2P mid-call until a separate handoff state is added.

## Device Signature Challenge

Current state:
- Sessions are token-hash backed, one active session per account, bound to the stored device public key.
- `SESSION_REFRESH` can re-bind a reconnecting socket after `HELLO` if the session token and device public key match.
- `verify_device_signature(device_public_key, nonce, nonce_signature)` exists as the verification boundary, but full asymmetric signing is not wired yet.

Next pass:
1. Add a server nonce challenge response instead of the current client-supplied placeholder signature.
2. Store a device signing public key separately from the ECDH key if the browser key usages require it.
3. Verify the signature server-side before rotating the session token.

## VAPID Push Delivery

Current state:
- `push_subscriptions` exists with encrypted subscription ciphertext and endpoint hash fields.
- The PWA has local notification permission/storage-persistence flow and does not store raw push endpoints server-side.

Next pass:
1. Add `PUSH_SUBSCRIBE` and `PUSH_UNSUBSCRIBE` authenticated commands.
2. Encrypt the browser push subscription before upload and store only ciphertext plus endpoint hash.
3. Configure VAPID keys outside source control.
4. Deliver call ringer, missed call, DM, and session/security pushes only to the current active device.
5. Keep push payloads bodyless by default; do not include plaintext message previews unless the user later opts in.
