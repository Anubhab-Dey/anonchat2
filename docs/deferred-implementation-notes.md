# Deferred Implementation Notes

These notes capture intentionally deferred work so the next pass can continue without redesigning the current model.

## TURN Relay Deployment

Current state:
- Calls use WebRTC media only.
- ICE servers are read from `web/config.js` through `window.ANONCHAT_CONFIG`.
- The app attempts WebRTC normally first, allowing host/server-reflexive candidates to win.
- If direct connectivity fails and trusted TURN servers are configured, ICE can select relay candidates automatically.
- The UI can report direct or relayed connection by inspecting the selected ICE candidate pair.
- The C server does not relay raw audio/video frames.

Next pass:
1. Deploy a first-party TURN service, preferably with TLS (`turns:`) and short-lived credentials.
2. Generate/serve TURN credentials from trusted server-side deployment config instead of committing static secrets.
3. Keep media in WebRTC DTLS-SRTP; the TURN server must only relay encrypted packets.
4. Add an operations guide for recommended coturn hardening, logging limits, and credential rotation.

## Call Ringer And State Flow

Current state:
- The backend keeps `CALL_INVITE`, `CALL_ACCEPT`, `CALL_DECLINE`, and `CALL_END`.
- These commands carry opaque encrypted payloads and are for call state/ringer/event flow only.
- Media fallback is handled by WebRTC ICE/TURN, not custom `CALL_RELAY` frames.
- Incoming call invites are classified from decrypted invite metadata, not from direct-user lookup guesses.
- The browser can restart call peer connections with relay-only ICE when trusted TURN servers are configured.

Next pass:
1. Add missed-call and active-device push hooks after VAPID is implemented.
2. Keep the call-event payload encrypted; do not add plaintext call metadata beyond routing fields needed for routing/key discovery.

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
