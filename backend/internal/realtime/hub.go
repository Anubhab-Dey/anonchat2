package realtime

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"anonchat2/backend/internal/call"
	"anonchat2/backend/internal/chat"
	"anonchat2/backend/internal/presence"
	"anonchat2/backend/internal/ratelimit"
	"anonchat2/backend/internal/room"
	"anonchat2/backend/internal/session"
	"anonchat2/backend/internal/store"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

const (
	maxReadBytes = 256 * 1024
	sendBuffer   = 32
)

type Options struct {
	Logger      *slog.Logger
	Store       *store.Store
	RateLimiter *ratelimit.Limiter
}

type Hub struct {
	log     *slog.Logger
	store   *store.Store
	limits  *ratelimit.Limiter
	calls   *call.Manager
	mu      sync.RWMutex
	clients map[string]map[*Client]struct{}
	rooms   map[string]map[*Client]struct{}
	done    chan struct{}
}

type Client struct {
	hub         *Hub
	conn        *websocket.Conn
	sessionID   string
	displayName string
	status      string
	roomID      string
	send        chan Event
}

func NewHub(options Options) *Hub {
	return &Hub{
		log:     options.Logger,
		store:   options.Store,
		limits:  options.RateLimiter,
		calls:   call.NewManager(),
		clients: make(map[string]map[*Client]struct{}),
		rooms:   make(map[string]map[*Client]struct{}),
		done:    make(chan struct{}),
	}
}

func (h *Hub) Run() {
	<-h.done
}

func (h *Hub) Shutdown() {
	select {
	case <-h.done:
		return
	default:
		close(h.done)
	}

	h.mu.RLock()
	defer h.mu.RUnlock()
	for _, clients := range h.clients {
		for client := range clients {
			client.close(websocket.StatusGoingAway, "Server is restarting.")
		}
	}
}

func (h *Hub) ServeWebSocket(w http.ResponseWriter, r *http.Request, sess session.Session) {
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		Subprotocols:       []string{"anonchat2.v1"},
		InsecureSkipVerify: true,
	})
	if err != nil {
		return
	}
	conn.SetReadLimit(maxReadBytes)

	client := &Client{
		hub:         h,
		conn:        conn,
		sessionID:   sess.ID,
		displayName: sess.DisplayName,
		status:      "online",
		send:        make(chan Event, sendBuffer),
	}

	h.register(client)
	defer h.unregister(client)

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	go client.writeLoop(ctx)
	client.enqueue(client.helloEvent("hello_ok"))
	client.readLoop(ctx)
}

func (h *Hub) register(client *Client) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.clients[client.sessionID] == nil {
		h.clients[client.sessionID] = make(map[*Client]struct{})
	}
	h.clients[client.sessionID][client] = struct{}{}
}

func (h *Hub) unregister(client *Client) {
	h.leaveRoom(client)

	h.mu.Lock()
	defer h.mu.Unlock()
	if clients := h.clients[client.sessionID]; clients != nil {
		delete(clients, client)
		if len(clients) == 0 {
			delete(h.clients, client.sessionID)
		}
	}
	close(client.send)
}

func (c *Client) readLoop(ctx context.Context) {
	for {
		var event Event
		if err := wsjson.Read(ctx, c.conn, &event); err != nil {
			if !isNormalClose(err) {
				c.hub.log.Debug("websocket read ended", "session", c.sessionID, "error", err)
			}
			return
		}
		c.handle(ctx, event)
	}
}

func (c *Client) writeLoop(ctx context.Context) {
	ticker := time.NewTicker(25 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case event, ok := <-c.send:
			if !ok {
				return
			}
			writeCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
			err := wsjson.Write(writeCtx, c.conn, event)
			cancel()
			if err != nil {
				c.close(websocket.StatusPolicyViolation, "Connection slowed down.")
				return
			}
		case <-ticker.C:
			pingCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
			err := c.conn.Ping(pingCtx)
			cancel()
			if err != nil {
				c.close(websocket.StatusPolicyViolation, "Connection timed out.")
				return
			}
		}
	}
}

func (c *Client) handle(ctx context.Context, event Event) {
	if event.ProtocolVersion != ProtocolVersion {
		c.sendError(event, "PROTOCOL_VERSION", "Please refresh AnonChat.")
		return
	}
	if !c.hub.limits.Allow(c.sessionID, eventCost(event.Type)) {
		c.enqueue(withRequest(NewEvent("rate_limited"), event))
		return
	}

	switch event.Type {
	case "hello":
		c.enqueue(withRequest(c.helloEvent("hello_ok"), event))
	case "resume":
		c.enqueue(withRequest(c.helloEvent("resume_ok"), event))
	case "join_room":
		c.handleJoin(ctx, event)
	case "leave_room":
		c.hub.leaveRoom(c)
		c.enqueue(withRequest(NewEvent("room_state"), event))
	case "send_message":
		c.handleMessage(event)
	case "call_start":
		c.handleCallStart(event)
	case "call_accept":
		c.handleCallTransition(event, call.StateAccepted, "call_state")
	case "call_reject":
		c.handleCallTransition(event, call.StateRejected, "call_state")
	case "call_end":
		c.handleCallTransition(event, call.StateEnded, "call_state")
	case "call_signal":
		c.handleCallSignal(event)
	case "presence_update":
		c.handlePresence(event)
	case "typing_start", "typing_stop":
		c.forwardToRoom(event, true)
	default:
		c.sendError(event, "UNKNOWN_EVENT", "That action is not available.")
	}
}

func (c *Client) handleJoin(ctx context.Context, event Event) {
	var payload struct {
		RoomID string `json:"room_id"`
	}
	_ = json.Unmarshal(event.Payload, &payload)
	roomID := payload.RoomID
	if roomID == "" {
		roomID = event.RoomID
	}
	cleanRoom, err := room.CleanID(roomID)
	if err != nil {
		c.sendError(event, "ROOM_INVALID", "That room link is not valid.")
		return
	}
	if err := c.hub.store.TouchRoom(ctx, cleanRoom); err != nil {
		c.sendError(event, "ROOM_UNAVAILABLE", "That room is not available right now.")
		return
	}

	c.hub.joinRoom(c, cleanRoom)
	c.enqueue(withRequest(c.hub.roomState(cleanRoom), event))
	c.hub.broadcast(cleanRoom, NewEvent("participant_joined"), map[string]any{
		"participant": c.participant(),
	}, c)
}

func (c *Client) handleMessage(event Event) {
	if c.roomID == "" {
		c.sendError(event, "ROOM_REQUIRED", "Join a room before sending.")
		return
	}
	var payload struct {
		Ciphertext string `json:"ciphertext"`
		Algorithm  string `json:"algorithm,omitempty"`
	}
	if err := json.Unmarshal(event.Payload, &payload); err != nil {
		c.sendError(event, "MESSAGE_INVALID", "That message could not be sent.")
		return
	}
	if err := chat.ValidateCiphertext(payload.Ciphertext); err != nil {
		c.sendError(event, "MESSAGE_INVALID", "That message is too long.")
		return
	}

	created := NewEvent("message_created")
	created.RoomID = c.roomID
	created.ClientMsgID = event.ClientMsgID
	created.Payload = Payload(map[string]any{
		"message_id":     serverID("msg"),
		"client_msg_id":  event.ClientMsgID,
		"sender":         c.participant(),
		"ciphertext":     payload.Ciphertext,
		"algorithm":      payload.Algorithm,
		"server_ordered": time.Now().UTC().UnixNano(),
	})
	c.hub.broadcast(c.roomID, created, nil, nil)
}

func (c *Client) handleCallStart(event Event) {
	if c.roomID == "" {
		c.sendError(event, "ROOM_REQUIRED", "Join a room before calling.")
		return
	}
	var payload struct {
		CallID string `json:"call_id"`
		Kind   string `json:"kind"`
	}
	_ = json.Unmarshal(event.Payload, &payload)
	if payload.CallID == "" {
		payload.CallID = serverID("call")
	}
	callSession, err := c.hub.calls.Start(payload.CallID, c.roomID, payload.Kind, c.sessionID)
	if err != nil {
		c.sendError(event, "CALL_INVALID", "Call could not start.")
		return
	}

	incoming := NewEvent("call_incoming")
	incoming.RoomID = c.roomID
	incoming.Payload = Payload(map[string]any{
		"call_id": callSession.ID,
		"kind":    callSession.Kind,
		"from":    c.participant(),
	})
	c.hub.broadcast(c.roomID, incoming, nil, c)

	state := NewEvent("call_state")
	state.RoomID = c.roomID
	state.Payload = Payload(map[string]any{
		"call_id": callSession.ID,
		"state":   callSession.State,
		"kind":    callSession.Kind,
		"from":    c.participant(),
	})
	c.hub.broadcast(c.roomID, state, nil, nil)
}

func (c *Client) handleCallTransition(event Event, state call.State, eventType string) {
	var payload struct {
		CallID string `json:"call_id"`
	}
	_ = json.Unmarshal(event.Payload, &payload)
	if payload.CallID == "" {
		c.sendError(event, "CALL_INVALID", "Call could not be updated.")
		return
	}
	callSession, ok := c.hub.calls.Transition(payload.CallID, state)
	if !ok {
		c.sendError(event, "CALL_MISSING", "That call already ended.")
		return
	}
	response := NewEvent(eventType)
	response.RoomID = callSession.RoomID
	response.Payload = Payload(map[string]any{
		"call_id": callSession.ID,
		"state":   callSession.State,
		"from":    c.participant(),
	})
	c.hub.broadcast(callSession.RoomID, response, nil, nil)
}

func (c *Client) handleCallSignal(event Event) {
	var payload struct {
		CallID              string          `json:"call_id"`
		TargetParticipantID string          `json:"target_participant_id,omitempty"`
		Signal              json.RawMessage `json:"signal"`
	}
	if err := json.Unmarshal(event.Payload, &payload); err != nil || len(payload.Signal) == 0 {
		c.sendError(event, "CALL_SIGNAL_INVALID", "Call could not connect.")
		return
	}
	callSession, ok := c.hub.calls.Get(payload.CallID)
	if !ok {
		c.sendError(event, "CALL_MISSING", "That call already ended.")
		return
	}
	if callSession.RoomID != c.roomID {
		c.sendError(event, "CALL_ROOM_MISMATCH", "Join the call room again.")
		return
	}

	forward := NewEvent("call_signal")
	forward.RoomID = callSession.RoomID
	forward.Payload = Payload(map[string]any{
		"call_id":               payload.CallID,
		"from":                  c.participant(),
		"target_participant_id": payload.TargetParticipantID,
		"signal":                json.RawMessage(payload.Signal),
	})

	if payload.TargetParticipantID != "" {
		c.hub.sendToParticipant(payload.TargetParticipantID, forward)
		return
	}
	c.hub.broadcast(callSession.RoomID, forward, nil, c)
}

func (c *Client) handlePresence(event Event) {
	var payload struct {
		Status string `json:"status"`
	}
	_ = json.Unmarshal(event.Payload, &payload)
	c.status = presence.CleanStatus(payload.Status)
	if c.roomID != "" {
		c.hub.broadcast(c.roomID, NewEvent("presence_state"), map[string]any{
			"participant": c.participant(),
		}, nil)
	}
}

func (c *Client) forwardToRoom(event Event, excludeSelf bool) {
	if c.roomID == "" {
		return
	}
	forward := NewEvent(event.Type)
	forward.RoomID = c.roomID
	forward.ClientMsgID = event.ClientMsgID
	forward.Payload = Payload(map[string]any{
		"from": c.participant(),
	})
	var except *Client
	if excludeSelf {
		except = c
	}
	c.hub.broadcast(c.roomID, forward, nil, except)
}

func (h *Hub) joinRoom(client *Client, roomID string) {
	h.leaveRoom(client)

	h.mu.Lock()
	defer h.mu.Unlock()
	if h.rooms[roomID] == nil {
		h.rooms[roomID] = make(map[*Client]struct{})
	}
	client.roomID = roomID
	h.rooms[roomID][client] = struct{}{}
}

func (h *Hub) leaveRoom(client *Client) {
	h.mu.Lock()
	oldRoom := client.roomID
	if oldRoom == "" {
		h.mu.Unlock()
		return
	}
	if clients := h.rooms[oldRoom]; clients != nil {
		delete(clients, client)
		if len(clients) == 0 {
			delete(h.rooms, oldRoom)
		}
	}
	client.roomID = ""
	h.mu.Unlock()

	left := NewEvent("participant_left")
	left.RoomID = oldRoom
	left.Payload = Payload(map[string]any{"participant_id": client.sessionID})
	h.broadcast(oldRoom, left, nil, client)
}

func (h *Hub) roomState(roomID string) Event {
	h.mu.RLock()
	clients := h.rooms[roomID]
	participants := make([]Participant, 0, len(clients))
	for client := range clients {
		participants = append(participants, client.participant())
	}
	h.mu.RUnlock()

	state := NewEvent("room_state")
	state.RoomID = roomID
	state.Payload = Payload(map[string]any{
		"room_id":      roomID,
		"participants": participants,
	})
	return state
}

func (h *Hub) broadcast(roomID string, event Event, payload any, except *Client) {
	if payload != nil {
		event.Payload = Payload(payload)
	}
	if event.RoomID == "" {
		event.RoomID = roomID
	}

	h.mu.RLock()
	clients := make([]*Client, 0, len(h.rooms[roomID]))
	for client := range h.rooms[roomID] {
		if client != except {
			clients = append(clients, client)
		}
	}
	h.mu.RUnlock()

	for _, client := range clients {
		client.enqueue(event)
	}
}

func (h *Hub) sendToParticipant(participantID string, event Event) {
	h.mu.RLock()
	clients := make([]*Client, 0, len(h.clients[participantID]))
	for client := range h.clients[participantID] {
		clients = append(clients, client)
	}
	h.mu.RUnlock()

	for _, client := range clients {
		client.enqueue(event)
	}
}

func (c *Client) participant() Participant {
	return Participant{
		ParticipantID: c.sessionID,
		DisplayName:   c.displayName,
		Status:        c.status,
	}
}

func (c *Client) helloEvent(eventType string) Event {
	event := NewEvent(eventType)
	event.Payload = Payload(map[string]any{
		"participant": c.participant(),
	})
	return event
}

func (c *Client) enqueue(event Event) {
	defer func() {
		_ = recover()
	}()
	if event.ProtocolVersion == 0 {
		event.ProtocolVersion = ProtocolVersion
	}
	if event.Timestamp == "" {
		event.Timestamp = time.Now().UTC().Format(time.RFC3339Nano)
	}
	select {
	case c.send <- event:
	default:
		c.close(websocket.StatusPolicyViolation, "Connection slowed down.")
	}
}

func (c *Client) sendError(request Event, code, message string) {
	event := withRequest(NewEvent("error"), request)
	event.Payload = Payload(map[string]any{
		"code":    code,
		"message": message,
	})
	c.enqueue(event)
}

func (c *Client) close(code websocket.StatusCode, reason string) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	_ = c.conn.Close(code, reason)
	<-ctx.Done()
}

func withRequest(event, request Event) Event {
	event.RequestID = request.RequestID
	event.ClientMsgID = request.ClientMsgID
	event.RoomID = firstNonEmpty(event.RoomID, request.RoomID)
	return event
}

func eventCost(eventType string) float64 {
	switch eventType {
	case "send_message":
		return 2
	case "call_signal":
		return 1.5
	default:
		return 1
	}
}

func isNormalClose(err error) bool {
	return errors.Is(err, context.Canceled) ||
		websocket.CloseStatus(err) == websocket.StatusNormalClosure ||
		websocket.CloseStatus(err) == websocket.StatusGoingAway
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}
