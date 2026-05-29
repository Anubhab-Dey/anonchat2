# Local Development

## Backend

From the repository root:

```powershell
cd backend
go mod tidy
go test ./...
go run ./cmd/server
```

If Go is installed but not on PATH on Windows, use:

```powershell
& 'C:\Program Files\Go\bin\go.exe' run ./cmd/server
```

The backend defaults to:

- `HTTP_ADDR=:8080`
- `DATABASE_PATH=anonchat.sqlite3`
- `DEV_MODE=true`
- safe localhost origins

## Frontend

```powershell
cd frontend
pnpm install
pnpm check
pnpm dev
```

The Vite dev server proxies `/api`, `/ws`, `/healthz`, `/readyz`, and `/turn-credentials.json` to `http://127.0.0.1:8080`.

## Production-Like Local Build

```powershell
cd frontend
pnpm build
cd ..\backend
go build ./cmd/server
```

Then run the backend from the repository root so it serves `frontend/build`.

## Environment Variables

Copy `.env.example` for local notes, but load variables through your shell, systemd unit, or deployment environment. Never commit real secrets.

- `HTTP_ADDR`: backend listen address.
- `PUBLIC_BASE_URL`: public HTTPS origin in production.
- `ALLOWED_ORIGINS`: comma-separated allowed browser origins.
- `DATABASE_PATH`: SQLite database path.
- `SESSION_COOKIE_NAME`: HttpOnly cookie name.
- `SESSION_SECRET`: cookie signing secret. Required and at least 32 bytes in production.
- `LOG_LEVEL`: `debug`, `info`, `warn`, or `error`.
- `DEV_MODE`: enables localhost defaults and non-secure cookies.
- `STUN_URLS`: comma-separated STUN URLs.
- `TURN_URLS`: comma-separated TURN URLs.
- `TURN_USERNAME`: TURN username when static credentials are used.
- `TURN_CREDENTIAL`: TURN credential when static credentials are used.
- `STATIC_DIR`: built frontend directory.
