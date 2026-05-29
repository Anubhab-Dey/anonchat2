# AnonChat2 Migration Plan

## 1. Existing Features Discovered

- Static installable PWA served from `web/` with `index.html`, `styles.css`, `manifest.webmanifest`, `sw.js`, and ES modules under `web/modules/`.
- Username/password signup and login with no email requirement.
- Client-side password proofing when WebCrypto is available. The browser derives a PBKDF2-SHA-256 proof before sending auth material to the server.
- SQLite-backed accounts, devices, sessions, encrypted backups, session events, call events, short-lived session nonces, and future push subscription records.
- Device-bound session continuity:
  - browser/PWA install creates an ECDSA P-256 signing key;
  - server stores the public key;
  - refresh uses a short-lived server nonce and ECDSA signature;
  - session tokens are rotated and hashed server-side.
- Local IndexedDB conversation history scoped per account.
- Local direct-message outbox with retry for currently offline direct users.
- Encrypted backup upload/download for local conversations and peer settings.
- Saved room entries that can be reopened and renamed.
- Invite links with room name and room password kept in the URL fragment.
- Browser-side encrypted room chat using a room passphrase-derived AES-GCM key.
- Separate browser-side room keys for chat, WebRTC signaling, and file frames.
- Direct username messages to online users using per-account ECDH keys and browser-side AES-GCM.
- Direct message delivery receipts.
- Presence for users in the same room through `PEER` and `LEFT` events.
- Room and direct WebRTC signaling relayed by the server as opaque encrypted payloads.
- Room and direct audio/video WebRTC calls.
- Call ringer flow: invite, accept, decline, end.
- WebRTC P2P first, TURN relay when configured, app-server encrypted audio-only fallback when WebRTC cannot connect.
- WebRTC data-channel file transfer with extra browser-side AES-GCM wrapping and SHA-256 verification.
- Local PWA notifications for messages/calls while the installed app is alive/backgrounded.
- TURN credential endpoint at `/turn-credentials.json`, using a server-side coturn shared secret.
- Default privacy posture: no server-side message/file/session-signaling persistence, no access logs, no third-party ICE servers by default.

## 2. Existing Backend Behavior Discovered

- Main backend is one C file: `src/server.c`.
- Build system is CMake with `CMakeLists.txt` and `CMakePresets.json`.
- Runtime dependencies:
  - `libwebsockets`
  - `sqlite3`
  - Windows `bcrypt` or Linux OpenSSL `libcrypto`
- The server:
  - serves static files from `ANONCHAT_WEB_DIR`, currently `web/`;
  - listens on `ANONCHAT_PORT`, default `8080`;
  - optionally binds `ANONCHAT_BIND`;
  - opens SQLite from `ANONCHAT_DB_PATH`, default `anonchat.sqlite3`;
  - accepts WebSocket traffic only at `/ws`;
  - exposes `/turn-credentials.json`;
  - suppresses libwebsockets logging.
- SQLite schema currently includes:
  - `users`
  - `devices`
  - `sessions`
  - `encrypted_backups`
  - `session_events`
  - `session_nonces`
  - `call_events`
  - `push_subscriptions`
- Current WebSocket protocol is pipe-delimited text with the `anonchat` subprotocol.
- Current client-to-server commands:
  - `HELLO`
  - `SIGNUP`
  - `LOGIN`
  - `SESSION_CHALLENGE`
  - `SESSION_REFRESH`
  - `BACKUP_GET`
  - `BACKUP_PUT`
  - `JOIN`
  - `LEAVE`
  - `CHAT`
  - `SIGNAL`
  - `KEY`
  - `WHO`
  - `DM`
  - `DM_RECEIVED`
  - `DSIGNAL`
  - `CALL_INVITE`
  - `CALL_ACCEPT`
  - `CALL_DECLINE`
  - `CALL_END`
  - `CALL_RELAY`
  - `PING`
- Current server-to-client frames:
  - `OK|hello`
  - `OK|auth|...`
  - `SESSION_NONCE|...`
  - `OK|session_refresh|...`
  - `SESSION_REPLACED|...`
  - `BACKUP|...`
  - `OK|backup_put|...`
  - `OK|join|...`
  - `OK|leave|...`
  - `PEER|...`
  - `LEFT|...`
  - `CHAT|...`
  - `SIGNAL|...`
  - `USER|...`
  - `DM|...`
  - `DM_RECEIPT|...`
  - `DSIGNAL|...`
  - `CALL_EVENT|...`
  - `CALL_RELAY|...`
  - `PONG`
  - `ERR|...`
- Backend memory limits and behavior:
  - max clients: `128`;
  - max frame bytes: `262144`;
  - per-client outbox: `16`;
  - call slots: `128`;
  - outbound queues drop/close rather than growing without bound.
- The server intentionally treats chat, DM, call signaling, file frames, and fallback audio media as opaque payloads.
- The server currently persists account/session/backup/call-event metadata, but not plaintext messages, files, SDP, ICE candidates, call media, or access logs.

## 3. Existing Frontend Behavior Discovered

- Main frontend is static HTML/CSS/ES modules, not SvelteKit.
- `web/app.js` wires boot, events, protocol handlers, session refresh, notifications, conversations, rooms, direct chat, calls, and file transfer.
- Core frontend modules:
  - `state.js`: global runtime state, app config, TURN credential loading.
  - `wire.js`: WebSocket lifecycle, reconnect queue, command dispatch.
  - `auth.js`: signup/login/password proof.
  - `device-session.js`: device identity, session refresh, cross-tab refresh coordination, session replacement UI.
  - `backup.js`: encrypted conversation backup upload/download.
  - `rooms.js`: room invite, key derivation, join, encrypted room chat.
  - `direct.js`: ECDH identity, direct user lookup, encrypted direct messages, retry outbox.
  - `calls.js`: call state machine and fallback orchestration.
  - `call-p2p.js`: WebRTC peer connections, room/direct signaling, local/remote media.
  - `call-relay.js`: encrypted call invite/accept/decline/end payloads.
  - `call-backend-relay.js`: encrypted audio-only app-server relay fallback.
  - `files.js`: WebRTC data-channel file transfer and SHA-256 verification.
  - `local-db.js`: IndexedDB conversations, messages, settings, direct outbox, backup import/export.
  - `notifications.js`: installed-PWA notification permission and local notifications.
  - `ui.js`, `dom.js`, `toast.js`: DOM rendering and messages.
- Current visible UX includes:
  - account sign up/sign in;
  - quick chat;
  - quick private room;
  - conversations list;
  - direct username chat/call;
  - room name and password;
  - invite link sharing;
  - room participant list;
  - settings for notifications/install/signout/clear device;
  - chat composer;
  - call panel with accept/decline/mute/camera/PiP/end controls;
  - files panel.
- Current frontend stores local conversation history and session settings in IndexedDB/localStorage.
- Current service worker caches the app shell and avoids caching `/local-config.js`, `/turn-credentials.json`, and `/ws`.

## 4. Current Build/Run/Deploy Assumptions

- Windows development is MSYS2 UCRT64 plus CMake:
  - `cmake --preset msys2-ucrt64-debug`
  - `cmake --build --preset msys2-ucrt64-debug`
  - `.\build\anonchat.exe`
- Linux development/deploy is CMake plus native libs:
  - `sudo apt install build-essential cmake libwebsockets-dev libsqlite3-dev libssl-dev`
  - `cmake --preset linux-debug`
  - `cmake --build --preset linux-debug`
  - `./build-linux/anonchat`
- App URL defaults to `http://127.0.0.1:8080/`.
- Current deployment expects HTTPS/WSS outside localhost.
- coturn notes and template live in `ops/coturn/`.
- `web/local-config.js` is ignored and used for deployment-local browser config.
- SQLite database files are ignored by `.gitignore`.

## 5. Features To Preserve Exactly

- Website/PWA-first app, not Play Store oriented.
- No email requirement.
- No message contents in backend logs or durable server storage.
- No call content in backend logs or durable server storage.
- No uploaded files stored on the backend.
- Room invite links keep room secrets in the URL fragment or otherwise off the server.
- Room messages are end-to-end encrypted in the browser before relay.
- WebRTC signaling payloads stay opaque to the backend.
- Direct-message payloads stay opaque to the backend.
- WebRTC P2P media remains the preferred call path.
- First-party TURN remains the supported internet call fallback.
- Backend media fallback, if present, remains encrypted audio-only.
- Local device history remains local by default.
- Session continuity survives reloads without making users understand tokens.
- Connection loss and refresh should show calm human messages.
- Cheap-VPS constraints: bounded queues, no busy loops, minimal dependencies.

## 6. Behavior To Preserve Exactly

- `GET /ws` remains the central realtime endpoint.
- The app remains usable at localhost without HTTPS for development.
- Static/PWA assets remain cacheable as an app shell without caching private chat contents.
- Browser obtains safe public call config from the backend.
- Server never requires plaintext room passwords.
- Server never needs plaintext messages, files, SDP, ICE candidates, or media chunks.
- Reconnect should not erase local conversations.
- Leaving a room notifies other room participants.
- Direct username lookup only succeeds for active online users.
- Calls can be accepted, rejected, and ended from either side.
- A slow client must not block broadcast to other clients.

## 7. Behavior To Improve

- Replace pipe-delimited realtime frames with a versioned JSON protocol carrying stable `type`, `protocol_version`, request/client IDs, timestamps, room IDs, and payloads.
- Replace the monolithic C server with domain-bounded Go packages.
- Add HTTP health/readiness endpoints.
- Add typed config loading with development defaults and production fail-fast checks.
- Add structured privacy-safe request logs with request IDs.
- Add stable JSON error responses for HTTP APIs.
- Add origin checks for WebSocket and CORS.
- Add explicit room/chat/call/presence/rate-limit modules.
- Add clearer session-expired and reconnect UI.
- Add a main/sub video layout, tap-to-switch, and draggable minimized call overlay instead of relying only on browser Picture-in-Picture.
- Add browser-native audio output/device controls where supported.
- Document local development, API, realtime protocol, calls, privacy, and operations in separate files.

## 8. Stack Migration Plan

1. Keep existing `src/` and `web/` in the working tree as behavior reference while building the new app.
2. Create `/backend` as a Go module.
3. Use:
   - Go standard library for HTTP server, config parsing, crypto helpers, JSON, context, and shutdown;
   - `github.com/go-chi/chi/v5` for routing;
   - `github.com/coder/websocket` for WebSockets;
   - `modernc.org/sqlite` for SQLite because it works on Windows dev and Linux VPS without CGO;
   - `log/slog` for structured logging.
4. Preserve the current SQLite privacy posture while adding the new minimal tables needed for anonymous/session continuity and optional compatibility.
5. Implement typed config:
   - `HTTP_ADDR`
   - `PUBLIC_BASE_URL`
   - `ALLOWED_ORIGINS`
   - `DATABASE_PATH`
   - `SESSION_COOKIE_NAME`
   - `SESSION_SECRET`
   - `LOG_LEVEL`
   - `DEV_MODE`
   - `STUN_URLS`
   - `TURN_URLS`
   - `TURN_USERNAME`
   - `TURN_CREDENTIAL`
6. Implement backend domains:
   - config
   - logger
   - HTTP middleware/errors/static serving
   - session
   - realtime hub
   - room
   - chat
   - call
   - presence
   - rate limiting
   - security/origin checks
   - SQLite store
   - health/readiness
7. Create `/frontend` as a SvelteKit TypeScript PWA using Vite and plain CSS.
8. Keep frontend state domains explicit:
   - API client
   - session state
   - realtime socket lifecycle
   - room/chat state
   - call/WebRTC state
   - media devices
   - UI state
9. Prefer browser-native crypto/media/WebRTC APIs and avoid heavy UI frameworks.
10. Keep deployment simple: single Linux backend binary serving the built frontend through Caddy.

## 9. Old Modules/Files To Replace

- `src/server.c`: replace as main backend with `/backend/cmd/server/main.go` and internal Go packages.
- `CMakeLists.txt` and `CMakePresets.json`: no longer primary build path; preserve temporarily as legacy reference until the migration is verified.
- `web/app.js` and `web/modules/*`: replace as primary frontend with SvelteKit modules under `/frontend/src/lib`.
- `web/index.html`, `web/styles.css`, `web/sw.js`, `web/manifest.webmanifest`: replace as primary PWA shell with SvelteKit/static equivalents.
- Pipe-delimited realtime protocol: replace with versioned JSON protocol.

## 10. Old Modules/Files/Assets To Preserve

- `web/icon.svg`: preserve the existing app icon unless a better asset is intentionally introduced.
- `web/local-config.example.js`: preserve the deployment idea as documented config, even if the new frontend uses `/api/config/client`.
- `ops/coturn/README.md` and `ops/coturn/turnserver.conf.example`: preserve/update for TURN deployment.
- `docs/PRIVACY_MODEL.md`: preserve/update to match the new Go/SvelteKit stack.
- Existing SQLite file is ignored and should not be deleted.
- Current C/static app files remain in-tree as legacy reference unless the user later asks to remove them.

## 11. Risks

- Existing account/session database compatibility is non-trivial because current auth uses custom password proofing, device ECDSA refresh, and hashed rotating tokens.
- The target product identity says anonymous by default, while the existing product already has accounts. The migration should support anonymous sessions first and preserve username-like display handles/direct lookup without requiring emails or durable personal identity.
- Rewriting WebRTC and encrypted file transfer can regress browser compatibility if rushed.
- Service worker caching can accidentally cache private state if scope is careless.
- TURN credentials must never be logged or bundled.
- Local history improves user convenience but increases device-side exposure.
- Backend relay audio fallback must remain bounded and opaque; it can become expensive if frame limits and rate limits are weak.
- `modernc.org/sqlite` has a larger transitive footprint than CGO SQLite but is chosen to preserve Windows/Linux reliability without native toolchain friction.
- Full old encrypted-backup compatibility may require a compatibility pass after the core Go/SvelteKit migration is stable.

## 12. Verification Commands

Backend:

```bash
cd backend
go mod tidy
gofmt -w .
go test ./...
go build ./cmd/server
```

Frontend:

```bash
cd frontend
pnpm install
pnpm check
pnpm build
```

Whole app smoke:

```bash
go run ./backend/cmd/server
```

Then verify:

- `GET /healthz` returns healthy JSON.
- `GET /readyz` returns ready JSON once SQLite is open.
- `GET /api/config/client` contains only safe public config.
- `POST /api/session/anonymous` creates/resumes an anonymous session cookie.
- `GET /api/session/me` returns the current safe session.
- Two browser tabs can join the same room and exchange messages.
- WebSocket reconnect preserves the same anonymous session.
- Calls can be started, accepted, rejected, and ended.
- Camera/microphone denial produces human-readable UI.
- No message text, call payload, raw tokens, or TURN credentials appear in logs.
