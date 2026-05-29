# HTTP API

All JSON errors use:

```json
{
  "ok": false,
  "error": {
    "code": "SESSION_EXPIRED",
    "message": "Your anonymous session expired. Start again to continue.",
    "request_id": "..."
  }
}
```

## `GET /healthz`

Returns process health.

## `GET /readyz`

Returns ready only after SQLite is reachable.

## `GET /api/config/client`

Returns safe public browser config:

- protocol version
- public base URL
- public ICE server config
- max encrypted message size

Secrets are never returned.

## `POST /api/session/anonymous`

Starts or resumes an anonymous session.

Request:

```json
{
  "display_name": "Avi"
}
```

Response:

```json
{
  "ok": true,
  "session": {
    "participant_id": "anon_...",
    "display_name": "Avi",
    "expires_at": "2026-06-28T..."
  }
}
```

The browser receives an HttpOnly cookie. The raw token is not exposed to frontend JavaScript.

## `GET /api/session/me`

Returns the current anonymous session or `SESSION_EXPIRED`.

## `GET /ws`

Versioned JSON realtime endpoint. Requires a valid anonymous session cookie.
