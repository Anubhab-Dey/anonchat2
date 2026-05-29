package call

import (
	"errors"
	"sync"
	"time"
)

type State string

const (
	StateRinging  State = "ringing"
	StateAccepted State = "accepted"
	StateRejected State = "rejected"
	StateEnded    State = "ended"
	StateFailed   State = "failed"
)

type Session struct {
	ID        string
	RoomID    string
	Kind      string
	CreatedBy string
	State     State
	StartedAt time.Time
	UpdatedAt time.Time
}

type Manager struct {
	mu    sync.Mutex
	calls map[string]Session
}

func NewManager() *Manager {
	return &Manager{calls: make(map[string]Session)}
}

func (m *Manager) Start(callID, roomID, kind, createdBy string) (Session, error) {
	if callID == "" || roomID == "" || createdBy == "" {
		return Session{}, errors.New("missing call identity")
	}
	if kind != "audio" && kind != "video" {
		kind = "video"
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	now := time.Now().UTC()
	session := Session{
		ID:        callID,
		RoomID:    roomID,
		Kind:      kind,
		CreatedBy: createdBy,
		State:     StateRinging,
		StartedAt: now,
		UpdatedAt: now,
	}
	m.calls[callID] = session
	return session, nil
}

func (m *Manager) Transition(callID string, state State) (Session, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()

	session, ok := m.calls[callID]
	if !ok {
		return Session{}, false
	}
	session.State = state
	session.UpdatedAt = time.Now().UTC()
	m.calls[callID] = session
	if state == StateEnded || state == StateRejected || state == StateFailed {
		delete(m.calls, callID)
	}
	return session, true
}

func (m *Manager) Get(callID string) (Session, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	session, ok := m.calls[callID]
	return session, ok
}
