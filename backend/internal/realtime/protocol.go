package realtime

import (
	"encoding/json"
	"time"
)

const ProtocolVersion = 1

type Event struct {
	Type            string          `json:"type"`
	ProtocolVersion int             `json:"protocol_version"`
	RequestID       string          `json:"request_id,omitempty"`
	ClientMsgID     string          `json:"client_msg_id,omitempty"`
	RoomID          string          `json:"room_id,omitempty"`
	Timestamp       string          `json:"timestamp,omitempty"`
	Payload         json.RawMessage `json:"payload,omitempty"`
}

type Participant struct {
	ParticipantID string `json:"participant_id"`
	DisplayName   string `json:"display_name"`
	Status        string `json:"status"`
}

func NewEvent(eventType string) Event {
	return Event{
		Type:            eventType,
		ProtocolVersion: ProtocolVersion,
		Timestamp:       time.Now().UTC().Format(time.RFC3339Nano),
	}
}

func Payload(value any) json.RawMessage {
	bytes, err := json.Marshal(value)
	if err != nil {
		return nil
	}
	return bytes
}
