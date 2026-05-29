package config

import (
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

type Config struct {
	HTTPAddr          string
	PublicBaseURL     string
	AllowedOrigins    []string
	DatabasePath      string
	SessionCookieName string
	SessionSecret     []byte
	LogLevel          string
	DevMode           bool
	STUNURLs          []string
	TURNURLs          []string
	TURNUsername      string
	TURNCredential    string
	StaticDir         string
}

func Load() (Config, error) {
	devMode := envBool("DEV_MODE", true)
	cfg := Config{
		HTTPAddr:          envString("HTTP_ADDR", ":8080"),
		PublicBaseURL:     strings.TrimSpace(os.Getenv("PUBLIC_BASE_URL")),
		AllowedOrigins:    splitList(os.Getenv("ALLOWED_ORIGINS")),
		DatabasePath:      envString("DATABASE_PATH", "anonchat.sqlite3"),
		SessionCookieName: envString("SESSION_COOKIE_NAME", "anonchat2_session"),
		LogLevel:          envString("LOG_LEVEL", choose(devMode, "debug", "info")),
		DevMode:           devMode,
		STUNURLs:          splitList(os.Getenv("STUN_URLS")),
		TURNURLs:          splitList(os.Getenv("TURN_URLS")),
		TURNUsername:      strings.TrimSpace(os.Getenv("TURN_USERNAME")),
		TURNCredential:    strings.TrimSpace(os.Getenv("TURN_CREDENTIAL")),
		StaticDir:         envString("STATIC_DIR", defaultStaticDir()),
	}

	secret := strings.TrimSpace(os.Getenv("SESSION_SECRET"))
	if secret == "" {
		if !devMode {
			return Config{}, errors.New("SESSION_SECRET is required when DEV_MODE=false")
		}
		secret = devSecret()
	}
	cfg.SessionSecret = []byte(secret)

	if len(cfg.SessionSecret) < 32 && !devMode {
		return Config{}, errors.New("SESSION_SECRET must be at least 32 bytes when DEV_MODE=false")
	}

	if !devMode && cfg.PublicBaseURL == "" {
		return Config{}, errors.New("PUBLIC_BASE_URL is required when DEV_MODE=false")
	}

	if cfg.PublicBaseURL != "" {
		origin, err := originFromURL(cfg.PublicBaseURL)
		if err != nil {
			return Config{}, fmt.Errorf("PUBLIC_BASE_URL: %w", err)
		}
		cfg.PublicBaseURL = strings.TrimRight(cfg.PublicBaseURL, "/")
		cfg.AllowedOrigins = appendIfMissing(cfg.AllowedOrigins, origin)
	}

	if devMode {
		cfg.AllowedOrigins = appendDevOrigins(cfg.AllowedOrigins)
	}

	if len(cfg.TURNURLs) > 0 && (cfg.TURNUsername == "" || cfg.TURNCredential == "") {
		return Config{}, errors.New("TURN_USERNAME and TURN_CREDENTIAL are required when TURN_URLS is set")
	}

	return cfg, nil
}

func envString(name, fallback string) string {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return fallback
	}
	return value
}

func envBool(name string, fallback bool) bool {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return fallback
	}
	parsed, err := strconv.ParseBool(value)
	if err != nil {
		return fallback
	}
	return parsed
}

func splitList(value string) []string {
	parts := strings.Split(value, ",")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		item := strings.TrimSpace(part)
		if item != "" {
			out = append(out, item)
		}
	}
	return out
}

func originFromURL(raw string) (string, error) {
	parsed, err := url.Parse(raw)
	if err != nil {
		return "", err
	}
	if parsed.Scheme == "" || parsed.Host == "" {
		return "", errors.New("must include scheme and host")
	}
	return parsed.Scheme + "://" + parsed.Host, nil
}

func appendDevOrigins(origins []string) []string {
	for _, origin := range []string{
		"http://localhost:5173",
		"http://127.0.0.1:5173",
		"http://localhost:8080",
		"http://127.0.0.1:8080",
	} {
		origins = appendIfMissing(origins, origin)
	}
	return origins
}

func appendIfMissing(values []string, next string) []string {
	for _, value := range values {
		if value == next {
			return values
		}
	}
	return append(values, next)
}

func defaultStaticDir() string {
	candidates := []string{
		filepath.Join("frontend", "build"),
		filepath.Join("..", "frontend", "build"),
	}
	for _, candidate := range candidates {
		if info, err := os.Stat(candidate); err == nil && info.IsDir() {
			return candidate
		}
	}
	return filepath.Join("frontend", "build")
}

func devSecret() string {
	var bytes [32]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		return "anonchat2-local-development-secret-only"
	}
	return base64.RawURLEncoding.EncodeToString(bytes[:])
}

func choose[T any](condition bool, yes, no T) T {
	if condition {
		return yes
	}
	return no
}
