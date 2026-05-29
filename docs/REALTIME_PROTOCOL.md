# Realtime Protocol

The WebSocket endpoint is `/ws` and uses subprotocol `anonchat2.v1`.

Every event has:

```json
{
  "type": "send_message",
  "protocol_version": 1,
  "request_id": "...",
  "client_msg_id": "...",
  "room_id": "lobby",
  "timestamp": "2026-05-29T12:00:00Z",
  "payload": {}
}
```

## Client To Server

- `hello`
- `resume`
- `join_room`
- `leave_room`
- `send_message`
- `call_start`
- `call_accept`
- `call_reject`
- `call_end`
- `call_signal`
- `presence_update`
- `typing_start`
- `typing_stop`

`send_message.payload.ciphertext` is browser-encrypted. The server validates only size and routeability.

`call_signal.payload.signal` is browser-encrypted WebRTC signaling. The server routes it without parsing SDP or ICE.

## Server To Client

- `hello_ok`
- `resume_ok`
- `room_state`
- `participant_joined`
- `participant_left`
- `message_created`
- `call_incoming`
- `call_state`
- `call_signal`
- `presence_state`
- `error`
- `rate_limited`

## Slow Clients

Each connection has a bounded send queue. A slow client is closed instead of blocking the room.

## Heartbeat

The backend sends WebSocket pings. Dead connections are closed and the frontend reconnects with backoff.
