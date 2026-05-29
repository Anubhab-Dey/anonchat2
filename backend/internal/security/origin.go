package security

import (
	"net/http"
	"strings"
)

type OriginChecker struct {
	allowed map[string]struct{}
	devMode bool
}

func NewOriginChecker(origins []string, devMode bool) OriginChecker {
	allowed := make(map[string]struct{}, len(origins))
	for _, origin := range origins {
		origin = strings.TrimRight(strings.TrimSpace(origin), "/")
		if origin != "" {
			allowed[origin] = struct{}{}
		}
	}
	return OriginChecker{allowed: allowed, devMode: devMode}
}

func (c OriginChecker) Allowed(origin string) bool {
	origin = strings.TrimRight(strings.TrimSpace(origin), "/")
	if origin == "" {
		return c.devMode
	}
	_, ok := c.allowed[origin]
	return ok
}

func (c OriginChecker) Check(r *http.Request) bool {
	return c.Allowed(r.Header.Get("Origin"))
}
