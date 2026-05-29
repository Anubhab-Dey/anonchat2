package realtime

import (
	"crypto/rand"
	"encoding/base64"
)

func serverID(prefix string) string {
	var bytes [12]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		return prefix + "_fallback"
	}
	return prefix + "_" + base64.RawURLEncoding.EncodeToString(bytes[:])
}
