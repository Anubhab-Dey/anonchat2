package session

import "testing"

func TestCleanDisplayName(t *testing.T) {
	got := CleanDisplayName("  Kid<script>  Test!!  ")
	if got != "Kidscript Test" {
		t.Fatalf("unexpected display name: %q", got)
	}
}
