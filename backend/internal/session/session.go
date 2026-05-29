package session

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"net/http"
	"regexp"
	"strings"
	"time"

	"anonchat2/backend/internal/store"
)

const (
	ttl       = 30 * 24 * time.Hour
	cookieVer = "v1"
)

var displayNamePattern = regexp.MustCompile(`[^a-zA-Z0-9_. -]+`)

type Options struct {
	Store      *store.Store
	CookieName string
	Secret     []byte
	DevMode    bool
}

type Service struct {
	store      *store.Store
	cookieName string
	secret     []byte
	devMode    bool
}

type Session struct {
	ID          string    `json:"participant_id"`
	DisplayName string    `json:"display_name"`
	ExpiresAt   time.Time `json:"expires_at"`
}

func NewService(options Options) *Service {
	return &Service{
		store:      options.Store,
		cookieName: options.CookieName,
		secret:     append([]byte(nil), options.Secret...),
		devMode:    options.DevMode,
	}
}

func (s *Service) CreateAnonymous(ctx context.Context, displayName string) (Session, string, error) {
	now := time.Now().UTC()
	id, err := randomText("anon_", 18)
	if err != nil {
		return Session{}, "", err
	}
	token, err := randomText("tok_", 32)
	if err != nil {
		return Session{}, "", err
	}
	name := CleanDisplayName(displayName)
	record := store.SessionRecord{
		ID:          id,
		TokenHash:   hashToken(token),
		DisplayName: name,
		CreatedAt:   now,
		ExpiresAt:   now.Add(ttl),
		LastSeenAt:  now,
	}
	if err := s.store.CreateSession(ctx, record); err != nil {
		return Session{}, "", err
	}

	return Session{ID: id, DisplayName: name, ExpiresAt: record.ExpiresAt}, s.cookieValue(id, token), nil
}

func (s *Service) AuthenticateRequest(r *http.Request) (Session, bool, error) {
	cookie, err := r.Cookie(s.cookieName)
	if err != nil || cookie.Value == "" {
		return Session{}, false, nil
	}

	id, token, ok := s.parseCookieValue(cookie.Value)
	if !ok {
		return Session{}, false, nil
	}

	record, found, err := s.store.SessionByID(r.Context(), id)
	if err != nil || !found {
		return Session{}, false, err
	}
	if record.RevokedAt.Valid || time.Now().UTC().After(record.ExpiresAt) {
		return Session{}, false, nil
	}
	if subtle.ConstantTimeCompare(record.TokenHash, hashToken(token)) != 1 {
		return Session{}, false, nil
	}

	nextExpiry := time.Now().UTC().Add(ttl)
	if err := s.store.TouchSession(r.Context(), id, nextExpiry); err != nil {
		return Session{}, false, err
	}

	return Session{ID: record.ID, DisplayName: record.DisplayName, ExpiresAt: nextExpiry}, true, nil
}

func (s *Service) ResumeOrCreate(w http.ResponseWriter, r *http.Request, displayName string) (Session, error) {
	if existing, ok, err := s.AuthenticateRequest(r); err != nil {
		return Session{}, err
	} else if ok {
		name := CleanDisplayName(displayName)
		if name != "" && name != existing.DisplayName {
			if err := s.store.UpdateDisplayName(r.Context(), existing.ID, name); err != nil {
				return Session{}, err
			}
			existing.DisplayName = name
		}
		s.SetCookie(w, s.cookieValue(existing.ID, tokenFromCookieMust(r, s.cookieName, s)))
		return existing, nil
	}

	created, cookieValue, err := s.CreateAnonymous(r.Context(), displayName)
	if err != nil {
		return Session{}, err
	}
	s.SetCookie(w, cookieValue)
	return created, nil
}

func (s *Service) SetCookie(w http.ResponseWriter, value string) {
	http.SetCookie(w, &http.Cookie{
		Name:     s.cookieName,
		Value:    value,
		Path:     "/",
		Expires:  time.Now().UTC().Add(ttl),
		MaxAge:   int(ttl.Seconds()),
		HttpOnly: true,
		Secure:   !s.devMode,
		SameSite: http.SameSiteLaxMode,
	})
}

func (s *Service) ClearCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name:     s.cookieName,
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   !s.devMode,
		SameSite: http.SameSiteLaxMode,
	})
}

func CleanDisplayName(value string) string {
	value = strings.TrimSpace(displayNamePattern.ReplaceAllString(value, ""))
	value = strings.Join(strings.Fields(value), " ")
	if value == "" {
		return "Anonymous"
	}
	if len(value) > 32 {
		value = value[:32]
	}
	return value
}

func (s *Service) cookieValue(id, token string) string {
	mac := s.sign(id, token)
	return strings.Join([]string{
		cookieVer,
		encode([]byte(id)),
		encode([]byte(token)),
		encode(mac),
	}, ".")
}

func (s *Service) parseCookieValue(value string) (string, string, bool) {
	parts := strings.Split(value, ".")
	if len(parts) != 4 || parts[0] != cookieVer {
		return "", "", false
	}

	idBytes, err := decode(parts[1])
	if err != nil {
		return "", "", false
	}
	tokenBytes, err := decode(parts[2])
	if err != nil {
		return "", "", false
	}
	mac, err := decode(parts[3])
	if err != nil {
		return "", "", false
	}

	id := string(idBytes)
	token := string(tokenBytes)
	expected := s.sign(id, token)
	if subtle.ConstantTimeCompare(mac, expected) != 1 {
		return "", "", false
	}
	return id, token, true
}

func (s *Service) sign(id, token string) []byte {
	mac := hmac.New(sha256.New, s.secret)
	mac.Write([]byte(cookieVer))
	mac.Write([]byte("|"))
	mac.Write([]byte(id))
	mac.Write([]byte("|"))
	mac.Write([]byte(token))
	return mac.Sum(nil)
}

func hashToken(token string) []byte {
	sum := sha256.Sum256([]byte(token))
	return sum[:]
}

func randomText(prefix string, byteCount int) (string, error) {
	if byteCount <= 0 {
		return "", errors.New("invalid random length")
	}
	bytes := make([]byte, byteCount)
	if _, err := rand.Read(bytes); err != nil {
		return "", err
	}
	return prefix + encode(bytes), nil
}

func encode(bytes []byte) string {
	return base64.RawURLEncoding.EncodeToString(bytes)
}

func decode(text string) ([]byte, error) {
	return base64.RawURLEncoding.DecodeString(text)
}

func tokenFromCookieMust(r *http.Request, cookieName string, service *Service) string {
	cookie, err := r.Cookie(cookieName)
	if err != nil {
		return ""
	}
	_, token, ok := service.parseCookieValue(cookie.Value)
	if !ok {
		return ""
	}
	return token
}
