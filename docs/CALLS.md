# Calls

AnonChat2 calls use browser-native WebRTC.

## Flow

1. A caller joins a room.
2. The caller starts an audio or video call.
3. The backend broadcasts `call_incoming` to the room.
4. A callee accepts or rejects.
5. WebRTC offers, answers, and ICE candidates are encrypted in the browser with the room signaling key.
6. The backend routes opaque `call_signal` payloads.
7. Media flows peer-to-peer when browsers can connect.

## User Controls

- audio call
- video call
- accept
- reject
- end
- mute/unmute microphone
- camera on/off
- browser-supported speaker output
- minimized floating call panel
- tap to restore

## Failure Handling

The UI uses human messages:

- `Reconnecting...`
- `Camera or microphone could not start.`
- `The other person left.`
- `This browser controls audio output.`
- `Call could not connect.`

## TURN

Configure first-party STUN/TURN through:

- `STUN_URLS`
- `TURN_URLS`
- `TURN_USERNAME`
- `TURN_CREDENTIAL`

The backend exposes only safe public ICE config. TURN relays encrypted WebRTC packets and does not decrypt call media.

The old C app included an encrypted app-server audio relay fallback. The new Go/SvelteKit path keeps the backend signaling-only by default; if app-server audio relay is reintroduced, it must remain encrypted, audio-only, bounded, and off by default.
