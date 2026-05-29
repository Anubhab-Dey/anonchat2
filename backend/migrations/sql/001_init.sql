PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
PRAGMA secure_delete = ON;

CREATE TABLE IF NOT EXISTS anon_sessions (
    id TEXT PRIMARY KEY,
    token_hash BLOB NOT NULL CHECK(length(token_hash) = 32),
    display_name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    revoked_at INTEGER NULL
);

CREATE INDEX IF NOT EXISTS idx_anon_sessions_active
    ON anon_sessions(expires_at, revoked_at);

CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rate_limit_events (
    key TEXT PRIMARY KEY,
    allowance REAL NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS call_state (
    call_id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    created_by_session_id TEXT NOT NULL,
    state TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
