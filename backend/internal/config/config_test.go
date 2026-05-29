package config

import "testing"

func TestSplitListTrimsEmptyValues(t *testing.T) {
	got := splitList(" stun:one , , turn:two ")
	if len(got) != 2 || got[0] != "stun:one" || got[1] != "turn:two" {
		t.Fatalf("unexpected split: %#v", got)
	}
}

func TestProductionRequiresSessionSecret(t *testing.T) {
	t.Setenv("DEV_MODE", "false")
	t.Setenv("SESSION_SECRET", "")
	t.Setenv("PUBLIC_BASE_URL", "https://chat.example.test")

	_, err := Load()
	if err == nil {
		t.Fatal("expected missing production session secret to fail")
	}
}
