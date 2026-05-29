package room

import (
	"errors"
	"regexp"
	"strings"
)

var roomIDPattern = regexp.MustCompile(`^[a-zA-Z0-9_.-]{1,64}$`)

func CleanID(value string) (string, error) {
	value = strings.TrimSpace(value)
	if !roomIDPattern.MatchString(value) {
		return "", errors.New("room id must use letters, numbers, dot, dash, or underscore")
	}
	return value, nil
}
