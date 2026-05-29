package httpapi

import (
	"encoding/json"
	"net/http"
)

type ErrorResponse struct {
	OK    bool      `json:"ok"`
	Error SafeError `json:"error"`
}

type SafeError struct {
	Code      string `json:"code"`
	Message   string `json:"message"`
	RequestID string `json:"request_id,omitempty"`
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeError(w http.ResponseWriter, r *http.Request, status int, code, message string) {
	writeJSON(w, status, ErrorResponse{
		OK: false,
		Error: SafeError{
			Code:      code,
			Message:   message,
			RequestID: requestIDFromContext(r.Context()),
		},
	})
}
