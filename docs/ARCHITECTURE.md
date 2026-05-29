# Architecture

AnonChat2 is now split into a Go backend and a SvelteKit PWA frontend.

## Backend

The backend lives in `backend/` and builds as one Linux-friendly binary.

- `cmd/server`: process startup and graceful shutdown.
- `internal/config`: typed environment loading with development defaults and production fail-fast checks.
- `internal/logger`: `slog` structured logging.
- `internal/http`: router, middleware, health, session APIs, safe errors, frontend serving.
- `internal/session`: anonymous session cookies backed by SQLite.
- `internal/realtime`: versioned JSON WebSocket hub with bounded client queues.
- `internal/room`: room ID validation.
- `internal/chat`: encrypted message payload validation.
- `internal/call`: in-memory active call state.
- `internal/presence`: presence state normalization.
- `internal/ratelimit`: cheap in-memory token buckets.
- `internal/security`: origin checks.
- `internal/store`: SQLite open/migration/access.

The backend does not parse or log message text, call media, SDP, or ICE contents. It routes opaque payloads and keeps only the session, room, and active-call state needed for continuity.

## Frontend

The frontend lives in `frontend/` and uses SvelteKit, TypeScript, Vite, and a small service worker.

- `src/lib/api`: typed API client.
- `src/lib/session`: anonymous session state.
- `src/lib/realtime`: WebSocket lifecycle and protocol helpers.
- `src/lib/chat`: browser-side room key derivation, encryption, and chat state.
- `src/lib/call`: WebRTC call state and signaling.
- `src/lib/media`: browser media device helpers.
- `src/lib/styles`: plain CSS.
- `src/routes`: the app UI.
- `static`: manifest, icon, and service worker.

The first screen is the app itself: start, join, chat, call, mute, camera, minimize, return, leave.
