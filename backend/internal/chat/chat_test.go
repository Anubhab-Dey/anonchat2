package chat

import "testing"

func TestValidateCiphertext(t *testing.T) {
	if err := ValidateCiphertext(""); err == nil {
		t.Fatal("empty message accepted")
	}
	if err := ValidateCiphertext("abc"); err != nil {
		t.Fatal(err)
	}
}
