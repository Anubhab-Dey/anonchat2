package chat

import "errors"

const MaxCiphertextBytes = 16 * 1024

func ValidateCiphertext(value string) error {
	if value == "" {
		return errors.New("message is empty")
	}
	if len(value) > MaxCiphertextBytes {
		return errors.New("message is too long")
	}
	return nil
}
