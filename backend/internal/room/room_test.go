package room

import "testing"

func TestCleanIDRejectsUnsafeRoom(t *testing.T) {
	if _, err := CleanID("../secret"); err == nil {
		t.Fatal("expected unsafe room id to fail")
	}
}
