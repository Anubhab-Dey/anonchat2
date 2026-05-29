# AnonChat2

AnonChat2 is a privacy-first anonymous realtime chat/call PWA for a small trusted circle on a cheap VPS.

The current main stack is:

- Frontend: SvelteKit, TypeScript, Vite, plain CSS, PWA shell, browser-native WebRTC.
- Backend: Go, chi, coder/websocket, SQLite, structured logs.

The old C/libwebsockets static PWA remains in `src/` and `web/` as the behavior reference during migration.

## Run Locally

Backend:

```powershell
cd backend
go mod tidy
go test ./...
go run ./cmd/server
```

Frontend dev server:

```powershell
cd frontend
pnpm install
pnpm check
pnpm dev
```

Open:

```text
http://127.0.0.1:5173/
```

Production-style build:

```powershell
cd frontend
pnpm build
cd ..\backend
go build -o anonchat2 ./cmd/server
```

Then run the backend from the repository root so it serves `frontend/build`, or set `STATIC_DIR`.

## Features

- Anonymous session start/resume with HttpOnly cookies.
- Private room join by room name and room password.
- Browser-side encrypted room chat.
- Versioned JSON realtime protocol over WebSocket.
- Room presence.
- Browser-native WebRTC audio/video calls.
- Incoming call accept/reject/end.
- Mic and camera toggles.
- Browser-supported speaker output.
- Minimized draggable call overlay.
- PWA manifest and service worker app shell.
- SQLite-first backend durability for only the state the app needs.
- Privacy-safe structured request logs.
- Health/readiness endpoints.

## Privacy Defaults

- No plaintext messages on the server.
- No call media on the server.
- No room passwords on the server.
- No secrets in the frontend bundle.
- No invasive analytics.
- No long-term IP history by app design.

Read `docs/PRIVACY_MODEL.md` before trusting this with sensitive conversations.

## Docs

- `docs/MIGRATION_PLAN.md`
- `docs/ARCHITECTURE.md`
- `docs/LOCAL_DEV.md`
- `docs/API.md`
- `docs/REALTIME_PROTOCOL.md`
- `docs/CALLS.md`
- `docs/OPERATIONS.md`
- `docs/PRIVACY_MODEL.md`

## Deployment

Use a reverse proxy with HTTPS/WSS. Caddy is the simplest default; see `ops/Caddyfile.example`.

For internet calls, configure first-party TURN. The existing coturn notes are in `ops/coturn/`.
