package httpapi

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"anonchat2/backend/internal/config"
	"anonchat2/backend/internal/health"
	"anonchat2/backend/internal/realtime"
	"anonchat2/backend/internal/security"
	"anonchat2/backend/internal/session"
	"anonchat2/backend/internal/store"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
)

type RouterOptions struct {
	Config   config.Config
	Logger   *slog.Logger
	Store    *store.Store
	Sessions *session.Service
	Hub      *realtime.Hub
}

func NewRouter(options RouterOptions) http.Handler {
	r := chi.NewRouter()
	origins := security.NewOriginChecker(options.Config.AllowedOrigins, options.Config.DevMode)

	r.Use(requestIDMiddleware)
	r.Use(recoverMiddleware(options.Logger))
	r.Use(loggingMiddleware(options.Logger))
	r.Use(corsMiddleware(origins))
	r.Use(noSniff)
	r.Use(limitBody)
	r.Use(middleware.RealIP)

	r.Get("/healthz", healthHandler)
	r.Get("/readyz", readyHandler(options.Store))
	r.Get("/api/config/client", clientConfigHandler(options.Config))
	r.Post("/api/session/anonymous", anonymousSessionHandler(options.Sessions))
	r.Get("/api/session/me", meHandler(options.Sessions))
	r.Get("/ws", websocketHandler(options.Sessions, options.Hub, origins))
	r.Get("/turn-credentials.json", legacyTurnConfigHandler(options.Config))

	serveStatic(r, options.Config.StaticDir)
	return r
}

func healthHandler(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "status": "healthy"})
}

func readyHandler(store *store.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !health.Ready(r.Context(), store) {
			writeError(w, r, http.StatusServiceUnavailable, "NOT_READY", "AnonChat is still starting.")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "status": "ready"})
	}
}

func anonymousSessionHandler(sessions *session.Service) http.HandlerFunc {
	type request struct {
		DisplayName string `json:"display_name"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		var body request
		if r.Body != nil {
			_ = json.NewDecoder(r.Body).Decode(&body)
		}
		sess, err := sessions.ResumeOrCreate(w, r, body.DisplayName)
		if err != nil {
			writeError(w, r, http.StatusInternalServerError, "SESSION_CREATE_FAILED", "Could not start a private session.")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "session": sess})
	}
}

func meHandler(sessions *session.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		sess, ok, err := sessions.AuthenticateRequest(r)
		if err != nil {
			writeError(w, r, http.StatusInternalServerError, "SESSION_CHECK_FAILED", "Could not check your session.")
			return
		}
		if !ok {
			writeError(w, r, http.StatusUnauthorized, "SESSION_EXPIRED", "Your anonymous session expired. Start again to continue.")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "session": sess})
	}
}

func websocketHandler(
	sessions *session.Service,
	hub *realtime.Hub,
	origins security.OriginChecker,
) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !origins.Check(r) {
			writeError(w, r, http.StatusForbidden, "ORIGIN_DENIED", "This AnonChat server does not allow that origin.")
			return
		}
		sess, ok, err := sessions.AuthenticateRequest(r)
		if err != nil {
			writeError(w, r, http.StatusInternalServerError, "SESSION_CHECK_FAILED", "Could not check your session.")
			return
		}
		if !ok {
			writeError(w, r, http.StatusUnauthorized, "SESSION_EXPIRED", "Your anonymous session expired. Start again to continue.")
			return
		}
		hub.ServeWebSocket(w, r, sess)
	}
}

func clientConfigHandler(cfg config.Config) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		iceServers := make([]map[string]any, 0, 2)
		if len(cfg.STUNURLs) > 0 {
			iceServers = append(iceServers, map[string]any{"urls": cfg.STUNURLs})
		}
		if len(cfg.TURNURLs) > 0 {
			iceServers = append(iceServers, map[string]any{
				"urls":       cfg.TURNURLs,
				"username":   cfg.TURNUsername,
				"credential": cfg.TURNCredential,
			})
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"ok": true,
			"config": map[string]any{
				"protocol_version":  1,
				"public_base_url":   cfg.PublicBaseURL,
				"ice_servers":       iceServers,
				"max_message_bytes": 16 * 1024,
			},
		})
	}
}

func legacyTurnConfigHandler(cfg config.Config) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		iceServers := make([]map[string]any, 0, 1)
		if len(cfg.TURNURLs) > 0 {
			iceServers = append(iceServers, map[string]any{
				"urls":       cfg.TURNURLs,
				"username":   cfg.TURNUsername,
				"credential": cfg.TURNCredential,
			})
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"iceServers": iceServers,
			"ttlSeconds": 0,
			"configured": len(iceServers) > 0,
		})
	}
}

func serveStatic(r chi.Router, staticDir string) {
	if info, err := os.Stat(staticDir); err != nil || !info.IsDir() {
		return
	}
	fileServer := http.FileServer(http.Dir(staticDir))
	r.Get("/*", func(w http.ResponseWriter, req *http.Request) {
		path := filepath.Join(staticDir, filepath.Clean(req.URL.Path))
		if info, err := os.Stat(path); err == nil && !info.IsDir() {
			fileServer.ServeHTTP(w, req)
			return
		}
		req.URL.Path = "/"
		if !strings.HasPrefix(req.URL.Path, "/") {
			req.URL.Path = "/" + req.URL.Path
		}
		http.ServeFile(w, req, filepath.Join(staticDir, "index.html"))
	})
}
