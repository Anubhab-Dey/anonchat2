package store

import (
	"context"
	"database/sql"
	"errors"
	"time"

	_ "modernc.org/sqlite"
)

type Store struct {
	db *sql.DB
}

type SessionRecord struct {
	ID          string
	TokenHash   []byte
	DisplayName string
	CreatedAt   time.Time
	ExpiresAt   time.Time
	LastSeenAt  time.Time
	RevokedAt   sql.NullTime
}

func Open(path string) (*Store, error) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	db.SetConnMaxLifetime(0)

	store := &Store{db: db}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := store.Ping(ctx); err != nil {
		_ = db.Close()
		return nil, err
	}
	return store, nil
}

func (s *Store) Close() error {
	return s.db.Close()
}

func (s *Store) Ping(ctx context.Context) error {
	return s.db.PingContext(ctx)
}

func (s *Store) Migrate(ctx context.Context) error {
	statements := []string{
		`PRAGMA foreign_keys = ON;`,
		`PRAGMA journal_mode = WAL;`,
		`PRAGMA busy_timeout = 5000;`,
		`PRAGMA secure_delete = ON;`,
		`CREATE TABLE IF NOT EXISTS anon_sessions (
			id TEXT PRIMARY KEY,
			token_hash BLOB NOT NULL CHECK(length(token_hash) = 32),
			display_name TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			expires_at INTEGER NOT NULL,
			last_seen_at INTEGER NOT NULL,
			revoked_at INTEGER NULL
		);`,
		`CREATE INDEX IF NOT EXISTS idx_anon_sessions_active
			ON anon_sessions(expires_at, revoked_at);`,
		`CREATE TABLE IF NOT EXISTS rooms (
			id TEXT PRIMARY KEY,
			created_at INTEGER NOT NULL,
			last_seen_at INTEGER NOT NULL
		);`,
		`CREATE TABLE IF NOT EXISTS rate_limit_events (
			key TEXT PRIMARY KEY,
			allowance REAL NOT NULL,
			updated_at INTEGER NOT NULL
		);`,
		`CREATE TABLE IF NOT EXISTS call_state (
			call_id TEXT PRIMARY KEY,
			room_id TEXT NOT NULL,
			created_by_session_id TEXT NOT NULL,
			state TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		);`,
	}

	for _, statement := range statements {
		if _, err := s.db.ExecContext(ctx, statement); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) CreateSession(ctx context.Context, record SessionRecord) error {
	_, err := s.db.ExecContext(
		ctx,
		`INSERT INTO anon_sessions
			(id, token_hash, display_name, created_at, expires_at, last_seen_at, revoked_at)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL);`,
		record.ID,
		record.TokenHash,
		record.DisplayName,
		record.CreatedAt.Unix(),
		record.ExpiresAt.Unix(),
		record.LastSeenAt.Unix(),
	)
	return err
}

func (s *Store) SessionByID(ctx context.Context, id string) (SessionRecord, bool, error) {
	var record SessionRecord
	var createdAt, expiresAt, lastSeenAt int64
	var revokedAt sql.NullInt64

	err := s.db.QueryRowContext(
		ctx,
		`SELECT id, token_hash, display_name, created_at, expires_at, last_seen_at, revoked_at
		 FROM anon_sessions
		 WHERE id = ?1;`,
		id,
	).Scan(
		&record.ID,
		&record.TokenHash,
		&record.DisplayName,
		&createdAt,
		&expiresAt,
		&lastSeenAt,
		&revokedAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return SessionRecord{}, false, nil
	}
	if err != nil {
		return SessionRecord{}, false, err
	}

	record.CreatedAt = time.Unix(createdAt, 0).UTC()
	record.ExpiresAt = time.Unix(expiresAt, 0).UTC()
	record.LastSeenAt = time.Unix(lastSeenAt, 0).UTC()
	if revokedAt.Valid {
		record.RevokedAt = sql.NullTime{Time: time.Unix(revokedAt.Int64, 0).UTC(), Valid: true}
	}
	return record, true, nil
}

func (s *Store) TouchSession(ctx context.Context, id string, expiresAt time.Time) error {
	_, err := s.db.ExecContext(
		ctx,
		`UPDATE anon_sessions
		 SET last_seen_at = ?1, expires_at = ?2
		 WHERE id = ?3 AND revoked_at IS NULL;`,
		time.Now().UTC().Unix(),
		expiresAt.Unix(),
		id,
	)
	return err
}

func (s *Store) UpdateDisplayName(ctx context.Context, id, displayName string) error {
	_, err := s.db.ExecContext(
		ctx,
		`UPDATE anon_sessions
		 SET display_name = ?1, last_seen_at = ?2
		 WHERE id = ?3 AND revoked_at IS NULL;`,
		displayName,
		time.Now().UTC().Unix(),
		id,
	)
	return err
}

func (s *Store) RevokeSession(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(
		ctx,
		`UPDATE anon_sessions
		 SET revoked_at = ?1
		 WHERE id = ?2 AND revoked_at IS NULL;`,
		time.Now().UTC().Unix(),
		id,
	)
	return err
}

func (s *Store) TouchRoom(ctx context.Context, id string) error {
	now := time.Now().UTC().Unix()
	_, err := s.db.ExecContext(
		ctx,
		`INSERT INTO rooms (id, created_at, last_seen_at)
		 VALUES (?1, ?2, ?2)
		 ON CONFLICT(id) DO UPDATE SET last_seen_at = excluded.last_seen_at;`,
		id,
		now,
	)
	return err
}
