package store

import (
	"context"
	"testing"
	"time"
)

func TestSessionRoundTrip(t *testing.T) {
	store, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	ctx := context.Background()
	if err := store.Migrate(ctx); err != nil {
		t.Fatal(err)
	}

	record := SessionRecord{
		ID:          "sess_test",
		TokenHash:   make([]byte, 32),
		DisplayName: "guest",
		CreatedAt:   time.Now().UTC(),
		ExpiresAt:   time.Now().UTC().Add(time.Hour),
		LastSeenAt:  time.Now().UTC(),
	}
	if err := store.CreateSession(ctx, record); err != nil {
		t.Fatal(err)
	}

	got, ok, err := store.SessionByID(ctx, record.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("session not found")
	}
	if got.DisplayName != record.DisplayName {
		t.Fatalf("display name = %q", got.DisplayName)
	}
}
