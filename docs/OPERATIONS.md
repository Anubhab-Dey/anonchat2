# Operations

## Build

```bash
cd frontend
pnpm install
pnpm build

cd ../backend
go test ./...
go build -o anonchat2 ./cmd/server
```

## systemd

```ini
[Unit]
Description=AnonChat2
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=anonchat
Group=anonchat
WorkingDirectory=/opt/anonchat2
Environment=DEV_MODE=false
Environment=HTTP_ADDR=127.0.0.1:8080
Environment=PUBLIC_BASE_URL=https://chat.example.com
Environment=ALLOWED_ORIGINS=https://chat.example.com
Environment=DATABASE_PATH=/var/lib/anonchat2/anonchat.sqlite3
Environment=SESSION_COOKIE_NAME=anonchat2_session
Environment=SESSION_SECRET=replace-with-long-random-secret
Environment=LOG_LEVEL=info
Environment=STATIC_DIR=/opt/anonchat2/frontend/build
ExecStart=/opt/anonchat2/backend/anonchat2
Restart=on-failure
RestartSec=2
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/var/lib/anonchat2

[Install]
WantedBy=multi-user.target
```

## Caddy

Use `ops/Caddyfile.example` as a starting point. Keep reverse-proxy access logs disabled unless you have a specific privacy-reviewed reason.

## Backups

Back up the SQLite database only if preserving anonymous session continuity matters. Do not back up logs containing request metadata longer than needed.

## coturn

Use `ops/coturn/` for the TURN server notes. Prefer first-party TURN over public ICE infrastructure for privacy.
